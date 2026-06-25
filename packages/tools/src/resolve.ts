/**
 * Entity resolution for relationship objects.
 *
 * When the enricher extracts a relationship whose object is a named entity
 * ("Acme is a Stripe customer"), we want a real edge to the Stripe entity, not
 * the string "Stripe". resolveOrCreateEntity matches the name to an existing
 * entity or, only when grounded, creates a lightweight CANDIDATE entity.
 *
 * Match order (cheap, deterministic so re-runs are idempotent):
 *   1. domain      — exact attributes.domain match (strongest)
 *   2. exact name  — normalized-equal (strips legal suffixes, case, punctuation)
 *   3. fuzzy       — trigram similarity >= FUZZY_THRESHOLD (conservative; avoids
 *                    false merges like "Apple" vs "Apple Music")
 *
 * No match -> create a candidate ONLY if grounded by a real domain. Otherwise
 * return null and the caller keeps the claim as object_text. We never invent
 * nodes from the LLM's say-so alone, and a name without a domain is not proof:
 * a "prior text mention" count can't tell a real org from a repeated junk phrase
 * (junk gets kept as text too), so domain is the bar for v1.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { act, type Actor } from '@agent-crm/primitives';
import { lookupEntity } from './reads.ts';

// Clear legal-entity forms only. Deliberately conservative: we'd rather miss a
// merge (a near-duplicate node) than wrongly merge two different orgs. Domain
// match catches the dedup these would otherwise handle.
const LEGAL_SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|gmbh|ag|plc|pte|llp|lp|s\.?a)\b/gi;

const FUZZY_THRESHOLD = 0.8;

/** Lowercase, drop punctuation + legal suffixes, collapse whitespace. */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bare registrable domain: strip scheme, www, and any path. */
export function normalizeDomain(d: string): string {
  return d.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
}

/**
 * Cheap pre-filter to skip obvious non-names before a DB lookup. NOT the
 * correctness boundary — resolve-first, domain grounding, and the caller's type
 * filter are. Only rejects clear sentences/descriptions.
 */
export function looksLikeEntityName(name: string): boolean {
  const t = name.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (t.split(/\s+/).length > 8) return false;
  if (/[\n\r]/.test(t)) return false;
  return true;
}

/** Jaccard over character trigrams. Deterministic. */
export function trigramSim(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const p = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface ResolveResult {
  entity_id: string | null;
  created: boolean;
  confidence: number;
  reason: 'domain' | 'exact' | 'fuzzy' | 'created' | 'self' | 'not_grounded' | 'not_a_name';
}

/**
 * Resolve `name` to an existing entity, or create a candidate entity when
 * grounded. `object_type` becomes the candidate's is_a. `subject_entity` is
 * excluded so a fact can't point at its own subject.
 */
export async function resolveOrCreateEntity(
  supabase: SupabaseClient,
  actor: Actor,
  args: {
    name: string;
    object_type: string;
    domain?: string | null;
    subject_entity: string;
    signal_id?: string | null;
  },
): Promise<ResolveResult> {
  const name = args.name.trim();
  if (!looksLikeEntityName(name)) return { entity_id: null, created: false, confidence: 0, reason: 'not_a_name' };
  const norm = normalizeEntityName(name);
  if (!norm) return { entity_id: null, created: false, confidence: 0, reason: 'not_a_name' };
  const domain = args.domain ? normalizeDomain(args.domain) : null;

  // 1. Domain match (strongest).
  if (domain) {
    const dm = await supabase
      .from('entities')
      .select('id')
      .eq('workspace_id', actor.workspace_id)
      .is('archived_at', null)
      .eq('attributes->>domain', domain)
      .limit(1)
      .maybeSingle();
    const id = dm.data?.id as string | undefined;
    if (id && id !== args.subject_entity) {
      return { entity_id: id, created: false, confidence: 0.98, reason: 'domain' };
    }
  }

  // Candidate pool: entities whose name contains the leading normalized token.
  const core = norm.split(' ')[0] || norm;
  const candidates = (await lookupEntity(supabase, actor.workspace_id, { name: core, fuzzy: true, limit: 25 }))
    .filter((c) => c.entity_id !== args.subject_entity);

  // 2. Normalized-exact name.
  const exact = candidates.find((c) => normalizeEntityName(c.name) === norm);
  if (exact) return { entity_id: exact.entity_id, created: false, confidence: 0.95, reason: 'exact' };

  // 3. Fuzzy (conservative).
  let best: { id: string; sim: number } | null = null;
  for (const c of candidates) {
    const sim = trigramSim(norm, normalizeEntityName(c.name));
    if (!best || sim > best.sim) best = { id: c.entity_id, sim };
  }
  if (best && best.sim >= FUZZY_THRESHOLD) {
    return { entity_id: best.id, created: false, confidence: best.sim, reason: 'fuzzy' };
  }

  // No match. Create a candidate ONLY if grounded by a real domain.
  if (!domain) return { entity_id: null, created: false, confidence: 0, reason: 'not_grounded' };

  const created = await act(supabase, actor, {
    tool: 'create_entity',
    args: {
      name,
      kind: args.object_type,
      // `_candidate: true` marks a thin node (no embedding/enrichment) so scoring
      // can treat it as a connection point until it's promoted. Underscore-prefixed
      // because it's internal bookkeeping — keeps it out of the human attributes grid.
      attributes: domain ? { domain, _candidate: true } : { _candidate: true },
    },
  });
  return { entity_id: created.target_id, created: true, confidence: 0.9, reason: 'created' };
}
