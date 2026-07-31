/**
 * Entity type lookups via `is_a` facts.
 *
 * Replaces the dropped `entities.kind` enum. Every read path that needs to
 * answer "what kind of thing is this entity" goes through these helpers so
 * the column → fact migration is a single point of change.
 *
 * Note: `is_a` is stored as a normal fact (predicate='is_a', object_text=<type>),
 * uniquely indexed by content_hash. An entity can have multiple active is_a
 * facts in principle (an "account" that is also a "partner"); helpers return
 * arrays. Most code only cares about presence ("is this an account?") and can
 * use `isEntityOfType`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from './paginate.ts';

export async function getEntityTypes(
  sb: SupabaseClient,
  entityId: string,
): Promise<string[]> {
  const { data } = await sb.from('facts')
    .select('object_text')
    .eq('subject_entity', entityId)
    .eq('predicate', 'is_a')
    .is('supersedes', null);
  return ((data ?? []) as Array<{ object_text: string | null }>)
    .map((r) => r.object_text)
    .filter((s): s is string => !!s);
}

export async function isEntityOfType(
  sb: SupabaseClient,
  entityId: string,
  type: string,
): Promise<boolean> {
  const { data } = await sb.from('facts')
    .select('id')
    .eq('subject_entity', entityId)
    .eq('predicate', 'is_a')
    .eq('object_text', type)
    .is('supersedes', null)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Batch lookup. Returns a map of entity_id → list of active is_a values.
 * Missing entries are absent from the map (callers should default to []).
 */
export async function getEntityTypesBatch(
  sb: SupabaseClient,
  entityIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (entityIds.length === 0) return out;
  const { data } = await sb.from('facts')
    .select('subject_entity, object_text')
    .in('subject_entity', entityIds)
    .eq('predicate', 'is_a')
    .is('supersedes', null);
  for (const row of (data ?? []) as Array<{ subject_entity: string; object_text: string | null }>) {
    if (!row.object_text) continue;
    const arr = out.get(row.subject_entity) ?? [];
    arr.push(row.object_text);
    out.set(row.subject_entity, arr);
  }
  return out;
}

/**
 * IDs of every entity in the workspace that currently has an active
 * (is_a, <type>) fact. Use when you want "all accounts" or "all contacts".
 */
export async function entityIdsOfType(
  sb: SupabaseClient,
  workspaceId: string,
  type: string,
): Promise<string[]> {
  // PostgREST caps a single response at 1000 rows; page through so workspaces
  // with more than 1000 entities of a type return the full set.
  const rows = await fetchAll<{ subject_entity: string }>((from, to) => sb.from('facts')
    .select('subject_entity')
    .eq('workspace_id', workspaceId)
    .eq('predicate', 'is_a')
    .eq('object_text', type)
    .is('supersedes', null)
    .range(from, to));
  return rows.map((r) => r.subject_entity);
}
