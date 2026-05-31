/**
 * Relationship helpers — flexible TS conveniences over the facts table.
 *
 * NOT a fixed query API. NOT a schema. These are common joins wrapped for ergonomics.
 * Anyone (agents, scripts, the UI) can ignore them and query `facts` directly.
 *
 * Add new helpers liberally. Removing or changing one only affects callers, not the schema.
 *
 * Conventions:
 *   - Every helper takes (supabase, workspace_id, ...) so it's workspace-scoped.
 *   - Every helper returns plain objects, not specialized types — easy to compose.
 *   - "Active" means `supersedes is null on something later`. We skip facts whose id is
 *      pointed at by another fact's `supersedes` column.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

async function typesForEntities(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (entity_ids.length === 0) return out;
  const { data } = await supabase.from('facts')
    .select('subject_entity, object_text')
    .eq('workspace_id', workspace_id)
    .eq('predicate', 'is_a')
    .is('supersedes', null)
    .in('subject_entity', entity_ids);
  for (const row of (data ?? []) as Array<{ subject_entity: string; object_text: string | null }>) {
    if (!row.object_text) continue;
    if (!out.has(row.subject_entity)) out.set(row.subject_entity, row.object_text);
  }
  return out;
}

export interface RelatedEntity {
  entity_id: string;
  name: string;
  kind: string;
  attributes: Record<string, unknown>;
  via_predicate: string;       // e.g. 'works_at', 'is_ceo_of'
  via_fact_id: string;
  confidence: number;
}

export interface FactRow {
  id: string;
  subject_entity: string;
  predicate: string;
  object_text: string | null;
  object_entity: string | null;
  confidence: number;
  observed_at: string;
}

/** Filter facts to those that have not been superseded by a newer fact. */
async function activeFactsForSubject(
  supabase: SupabaseClient,
  workspace_id: string,
  subject_entity: string,
): Promise<FactRow[]> {
  const all = await supabase
    .from('facts')
    .select('id, subject_entity, predicate, object_text, object_entity, confidence, observed_at, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', subject_entity);
  if (all.error) throw all.error;
  const rows = (all.data ?? []) as Array<FactRow & { supersedes: string | null }>;
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  return rows.filter((r) => !supersededIds.has(r.id));
}

/**
 * Filter already-fetched fact rows to those NOT superseded by a newer fact.
 * Correct for any query direction (subject- or object-side): it asks directly
 * whether any fact points at these ids via `supersedes`. Use this instead of
 * `.is('supersedes', null)`, which returns the STALE original — supersede_fact
 * writes new.supersedes = old.id, so the original keeps supersedes null.
 */
export async function excludeSuperseded<T extends { id: string }>(
  supabase: SupabaseClient,
  workspace_id: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const { data } = await supabase
    .from('facts')
    .select('supersedes')
    .eq('workspace_id', workspace_id)
    .in('supersedes', rows.map((r) => r.id));
  const superseded = new Set(
    ((data ?? []) as Array<{ supersedes: string | null }>)
      .map((r) => r.supersedes)
      .filter((x): x is string => !!x),
  );
  return rows.filter((r) => !superseded.has(r.id));
}

/** Given an account, return all entities linked TO it via any fact (e.g. contacts, opps).
 *  Walks `object_entity = account_id` direction. */
export async function relatedToEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  account_id: string,
  predicates?: string[],
): Promise<RelatedEntity[]> {
  let q = supabase
    .from('facts')
    .select('id, subject_entity, predicate, confidence, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('object_entity', account_id);
  if (predicates?.length) q = q.in('predicate', predicates);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; subject_entity: string; predicate: string; confidence: number; supersedes: string | null }>;
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const active = rows.filter((r) => !supersededIds.has(r.id));
  if (active.length === 0) return [];

  const ids = Array.from(new Set(active.map((r) => r.subject_entity)));
  const [ents, kindByEntity] = await Promise.all([
    supabase
      .from('entities')
      .select('id, name, attributes')
      .in('id', ids),
    typesForEntities(supabase, workspace_id, ids),
  ]);
  if (ents.error) throw ents.error;
  const byId = new Map((ents.data ?? []).map((e) => [e.id as string, e]));

  return active.flatMap((r) => {
    const e = byId.get(r.subject_entity);
    if (!e) return [];
    return [{
      entity_id: r.subject_entity,
      name: e.name as string,
      kind: kindByEntity.get(r.subject_entity) ?? 'entity',
      attributes: (e.attributes ?? {}) as Record<string, unknown>,
      via_predicate: r.predicate,
      via_fact_id: r.id,
      confidence: r.confidence,
    }];
  });
}

/** Common case: contacts at a given account. Wraps relatedToEntity with role-ish predicates. */
export function contactsAt(supabase: SupabaseClient, workspace_id: string, account_id: string) {
  return relatedToEntity(supabase, workspace_id, account_id);
}

/** Walks `subject_entity = contact_id` direction. Returns accounts/orgs the contact relates to. */
export async function entitiesFromSubject(
  supabase: SupabaseClient,
  workspace_id: string,
  subject_entity: string,
  predicates?: string[],
): Promise<RelatedEntity[]> {
  const facts = await activeFactsForSubject(supabase, workspace_id, subject_entity);
  const filtered = predicates?.length ? facts.filter((f) => predicates.includes(f.predicate)) : facts;
  const targetIds = filtered.map((f) => f.object_entity).filter((x): x is string => !!x);
  if (targetIds.length === 0) return [];
  const uniq = Array.from(new Set(targetIds));
  const [ents, kindByEntity] = await Promise.all([
    supabase
      .from('entities')
      .select('id, name, attributes')
      .in('id', uniq),
    typesForEntities(supabase, workspace_id, uniq),
  ]);
  if (ents.error) throw ents.error;
  const byId = new Map((ents.data ?? []).map((e) => [e.id as string, e]));

  return filtered.flatMap((f) => {
    if (!f.object_entity) return [];
    const e = byId.get(f.object_entity);
    if (!e) return [];
    return [{
      entity_id: f.object_entity,
      name: e.name as string,
      kind: kindByEntity.get(f.object_entity) ?? 'entity',
      attributes: (e.attributes ?? {}) as Record<string, unknown>,
      via_predicate: f.predicate,
      via_fact_id: f.id,
      confidence: f.confidence,
    }];
  });
}

/** Find the contact's current role at a given account. Returns the most recent
 *  active is_*_of fact linking contact -> account. */
export async function currentRole(
  supabase: SupabaseClient,
  workspace_id: string,
  contact_id: string,
  account_id: string,
): Promise<{ predicate: string; fact_id: string; confidence: number } | null> {
  const facts = await activeFactsForSubject(supabase, workspace_id, contact_id);
  const role = facts
    .filter((f) => f.object_entity === account_id)
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
  if (!role) return null;
  return { predicate: role.predicate, fact_id: role.id, confidence: role.confidence };
}

/** All non-superseded facts on an entity, raw. The flexible primitive most callers want. */
export async function activeFacts(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<FactRow[]> {
  return activeFactsForSubject(supabase, workspace_id, entity_id);
}

/** Free-form: find any entity by name match (case-insensitive). For LLM-driven entity
 *  resolution where the agent has a name string and wants to find an existing entity. */
export async function findEntityByName(
  supabase: SupabaseClient,
  workspace_id: string,
  name: string,
  kind?: string,
): Promise<{ id: string; name: string; kind: string } | null> {
  const { data: matches } = await supabase
    .from('entities')
    .select('id, name')
    .eq('workspace_id', workspace_id)
    .ilike('name', name)
    .limit(kind ? 25 : 1);
  const rows = (matches ?? []) as Array<{ id: string; name: string }>;
  if (rows.length === 0) return null;
  if (!kind) {
    const kinds = await typesForEntities(supabase, workspace_id, [rows[0]!.id]);
    return { id: rows[0]!.id, name: rows[0]!.name, kind: kinds.get(rows[0]!.id) ?? 'entity' };
  }
  const kinds = await typesForEntities(supabase, workspace_id, rows.map((r) => r.id));
  for (const r of rows) {
    if (kinds.get(r.id) === kind) return { id: r.id, name: r.name, kind };
  }
  return null;
}
