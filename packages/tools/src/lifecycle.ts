/**
 * Outreach-lifecycle helper. One place that records where an account is in the
 * outreach process, as a single supersede-chained fact. Called by code at
 * deterministic transition points (enricher done, draft created, send
 * approved, reply detected) — the agent's own actions.
 *
 * Nothing here is a hardcoded customer-facing name. The transition KEYS
 * (researched/drafted/contacted/replied) are code-level events; the fact NAME
 * and the LABEL written for each key come from policy.lifecycle, with neutral
 * defaults (see policy.ts). A customer renames the fact or any label in config.
 *
 * Imports kept local to avoid a cycle with index.ts (callTool) — same pattern
 * as ingest.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor } from '@agent-crm/primitives';
import { callTool } from './index.ts';
import { getPolicy, type OutreachTransition } from './policy.ts';

export const DEFAULT_STAGE_FACT_NAME = 'outreach_stage';

// Ordering of the transition keys. only_advance uses this so a later, earlier-
// ranked transition (e.g. an enricher re-run → researched) can't regress an
// account that's already further along (e.g. contacted).
const ORDER: Record<OutreachTransition, number> = {
  researched: 0,
  drafted: 1,
  contacted: 2,
  replied: 3,
};

function resolveStage(
  policy: { lifecycle?: { stage_fact_name?: string; labels?: Partial<Record<OutreachTransition, string>> } },
  key: OutreachTransition,
): { factName: string; label: string } {
  const lc = policy.lifecycle ?? {};
  return {
    factName: lc.stage_fact_name && lc.stage_fact_name.length ? lc.stage_fact_name : DEFAULT_STAGE_FACT_NAME,
    label: lc.labels?.[key] ?? key,
  };
}

/**
 * Write the outreach-stage fact for an entity via supersede-upsert.
 *
 * - Reads the current stage (the row NOT pointed at by any other row's
 *   supersedes — `supersedes is null` would return the stale original).
 * - No-op if already at this label.
 * - only_advance (default true): skip if the current label outranks the new
 *   one, so backward transitions never fork the chain. The 'replied' key is
 *   allowed to follow 'contacted' naturally since it outranks it.
 *
 * Returns { ok, changed }. changed=false on a no-op (unchanged or guarded).
 */
export async function setOutreachStage(
  supabase: SupabaseClient,
  actor: Actor,
  entity_id: string,
  key: OutreachTransition,
  opts: { signal_id?: string; only_advance?: boolean } = {},
): Promise<{ ok: boolean; changed: boolean }> {
  const only_advance = opts.only_advance ?? true;
  const policy = await getPolicy(supabase, actor.workspace_id);
  const { factName, label } = resolveStage(policy, key);

  // Build a reverse map (label -> rank) so the guard works even when labels are
  // customized. Falls back to the new key's rank if a stored label isn't known.
  const labelRank = (stored: string): number => {
    const lc = policy.lifecycle?.labels ?? {};
    for (const k of Object.keys(ORDER) as OutreachTransition[]) {
      const l = lc[k] ?? k;
      if (l === stored) return ORDER[k];
    }
    return -1; // unknown stored label — treat as earliest so we don't block
  };

  const all = await supabase.from('facts')
    .select('id, object_text, supersedes')
    .eq('workspace_id', actor.workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', factName);
  const rows = all.data ?? [];
  const pointedTo = new Set(rows.map((r) => r.supersedes).filter(Boolean) as string[]);
  const current = rows.find((r) => !pointedTo.has(r.id as string));

  if (current) {
    if (current.object_text === label) return { ok: true, changed: false }; // unchanged
    if (only_advance && labelRank(current.object_text as string) >= ORDER[key]) {
      return { ok: true, changed: false }; // would regress — skip
    }
    const r = await callTool(supabase, actor, 'supersede_fact', {
      subject_entity: entity_id, predicate: factName, object_text: label,
      confidence: 1.0, supersedes: current.id as string, signal_id: opts.signal_id,
    });
    return { ok: r.ok, changed: r.ok };
  }

  const r = await callTool(supabase, actor, 'assert_fact', {
    subject_entity: entity_id, predicate: factName, object_text: label,
    confidence: 1.0, signal_id: opts.signal_id,
  });
  return { ok: r.ok, changed: r.ok };
}
