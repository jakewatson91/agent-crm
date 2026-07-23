/**
 * Duplicate-account detection + merge. The pipeline never merges on its own: it detects
 * likely-same accounts and the UI surfaces a proposal the human approves or rejects
 * (see the merge card on the entity page). This is deliberately generous on detection —
 * a shared domain, a similar name, or one shared significant token — and lets the human
 * filter the false positives (it will propose "NHL" and "Rogers NHL Live" as matches for
 * "NHL Network"; the operator keeps the NHL-operated ones and rejects Rogers, a different
 * company that only licenses NHL content). The merge itself runs in the atomic
 * merge_accounts RPC (migration 0046) so a half-merge can't happen.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeEntityName, normalizeDomain, trigramSim } from './resolve.ts';
import { entityIdsOfType } from './entity_types.ts';

const TRIGRAM_MIN = 0.55;
const TOKEN_MIN_LEN = 3;
const MAX_CANDIDATES = 5;

// Universal company-structure words — NOT distinctive of a specific company, so sharing
// one is not evidence of a duplicate ("NHL Network" vs "WWE Network" share only "network").
// These are generic across every vertical (a fintech and a healthcare book both have
// "X Group", "Y Media"), so they live in code, not vertical config. Document frequency
// can't catch these on its own: in one workspace "network" can be as rare as a real brand.
const GENERIC_NAME_TOKENS = new Set([
  'network', 'media', 'group', 'holding', 'holdings', 'live', 'global', 'international',
  'worldwide', 'company', 'the', 'and', 'systems', 'solutions', 'services', 'technologies',
  'technology', 'digital', 'ventures', 'partners', 'associates', 'enterprises',
]);
// A token shared by more than this fraction of the book is workspace-common (every account
// is "Acme X"), so it also stops being distinctive.
const COMMON_TOKEN_FRACTION = 0.01;

export interface MergeCandidate {
  entity_id: string;
  name: string;
  domain: string | null;
  reason: 'domain' | 'name' | 'name_token';
  similarity: number;
}

function significantTokens(norm: string): Set<string> {
  return new Set(norm.split(' ').filter((t) => t.length >= TOKEN_MIN_LEN));
}

/**
 * Accounts that look like the same buyer as `entity_id`. Read-only; excludes the entity
 * itself, archived rows, and pairs the operator already dismissed (_merge_dismissed).
 */
export async function findMergeCandidatesForEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<MergeCandidate[]> {
  const target = await supabase.from('entities').select('name, attributes').eq('id', entity_id).maybeSingle();
  if (!target.data) return [];
  const tName = (target.data.name as string) ?? '';
  const tAttr = (target.data.attributes ?? {}) as { domain?: string; _merge_dismissed?: string[] };
  const tNorm = normalizeEntityName(tName);
  const tDomain = tAttr.domain ? normalizeDomain(tAttr.domain) : null;
  const tTokens = significantTokens(tNorm);
  const dismissed = new Set(tAttr._merge_dismissed ?? []);

  const acctIds = (await entityIdsOfType(supabase, workspace_id, 'account')).filter((id) => id !== entity_id);
  if (!acctIds.length) return [];

  // Load every account row once — needed for the token document-frequency map and the match.
  const rows: Array<{ id: string; name: string; attributes: { domain?: string; _merge_dismissed?: string[] } | null }> = [];
  const CHUNK = 300;
  for (let i = 0; i < acctIds.length; i += CHUNK) {
    const chunk = acctIds.slice(i, i + CHUNK);
    const { data } = await supabase.from('entities').select('id, name, attributes').in('id', chunk).is('archived_at', null);
    rows.push(...((data ?? []) as typeof rows));
  }

  // Token document frequency across the book, so a token common in THIS workspace also
  // stops counting as distinctive (beyond the universal generic list).
  const df = new Map<string, number>();
  for (const r of rows) for (const t of significantTokens(normalizeEntityName(r.name ?? ''))) df.set(t, (df.get(t) ?? 0) + 1);
  for (const t of tTokens) df.set(t, (df.get(t) ?? 0) + 1);
  const N = rows.length + 1;
  const commonMax = Math.max(4, Math.floor(N * COMMON_TOKEN_FRACTION));
  const isDistinctive = (t: string) => !GENERIC_NAME_TOKENS.has(t) && (df.get(t) ?? 0) <= commonMax;
  const distinctiveTarget = new Set([...tTokens].filter(isDistinctive));

  const out: MergeCandidate[] = [];
  for (const c of rows) {
    if (dismissed.has(c.id)) continue;
    if ((c.attributes?._merge_dismissed ?? []).includes(entity_id)) continue;
    const cNorm = normalizeEntityName(c.name ?? '');
    const cDomain = c.attributes?.domain ? normalizeDomain(c.attributes.domain) : null;
    let reason: MergeCandidate['reason'] | null = null;
    let sim = 0;
    if (tDomain && cDomain && tDomain === cDomain) {
      reason = 'domain'; sim = 0.98;
    } else {
      const tg = trigramSim(tNorm, cNorm);
      if (tg >= TRIGRAM_MIN) {
        reason = 'name'; sim = tg;
      } else {
        // Require a shared DISTINCTIVE token — a shared brand ("nhl"), not a shared generic
        // word ("network"). Rank by how rare the rarest shared distinctive token is.
        const cTokens = significantTokens(cNorm);
        let minDf = Infinity;
        for (const t of distinctiveTarget) if (cTokens.has(t)) minDf = Math.min(minDf, df.get(t) ?? Infinity);
        if (minDf !== Infinity) { reason = 'name_token'; sim = 0.5 + 0.45 * (1 - minDf / N); }
      }
    }
    if (reason) out.push({ entity_id: c.id, name: c.name, domain: cDomain, reason, similarity: sim });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, MAX_CANDIDATES);
}

export interface MergeResult {
  facts_moved: number;
  facts_duplicate: number;
  signals_moved: number;
  posts_moved: number;
  links_moved: number;
}

/** Execute an approved merge (atomic RPC), then log an entities_merged event for replay/undo. */
export async function mergeAccounts(
  supabase: SupabaseClient,
  workspace_id: string,
  canonical_id: string,
  duplicate_id: string,
): Promise<MergeResult> {
  const { data, error } = await supabase.rpc('merge_accounts', {
    p_workspace_id: workspace_id, p_canonical: canonical_id, p_duplicate: duplicate_id,
  });
  if (error) throw new Error(`merge_accounts failed: ${error.message}`);
  await supabase.from('events').insert({
    workspace_id, actor_kind: 'user', actor_id: 'merge', action: 'entities_merged',
    target_kind: 'entity', target_id: canonical_id,
    payload: { merged_from: duplicate_id, result: data },
  });
  return data as MergeResult;
}

/** Record that the operator rejected a merge between two entities so it stops proposing it. */
export async function dismissMergeCandidate(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
  other_id: string,
): Promise<void> {
  for (const [a, b] of [[entity_id, other_id], [other_id, entity_id]] as const) {
    const { data } = await supabase.from('entities').select('attributes').eq('id', a).maybeSingle();
    const attr = (data?.attributes ?? {}) as { _merge_dismissed?: string[] };
    const list = new Set(attr._merge_dismissed ?? []);
    list.add(b);
    await supabase.from('entities').update({ attributes: { ...attr, _merge_dismissed: [...list] } })
      .eq('id', a).eq('workspace_id', workspace_id);
  }
}
