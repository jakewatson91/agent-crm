/**
 * L3 — subscription embedding drift.
 *
 * Every 30 minutes, find positive matches in the window (signals where the
 * enricher fired AND extracted >= 1 fact) and blend their embeddings into
 * the matched subscription's learned_centroid via EMA.
 *
 * Mechanics:
 *   - "Positive" = events.action='agent_dispatch_result' where
 *     payload.behavior='enricher' AND payload.ok=true AND payload.facts_asserted>=1.
 *   - Group positives by subscription_id (from payload). Skip if missing.
 *   - For each subscription: pull current learned_centroid + positive_count,
 *     pull the signals' embeddings, EMA-blend with α=0.2 per positive.
 *   - First-ever positive: centroid = the signal embedding directly (no blend).
 *
 * Why EMA: each new positive shifts the centroid by 20%. After 10 positives,
 * the first contributes 0.8^10 ≈ 11%. Naturally decays old positives without
 * needing a sliding window store. Matches the rate-of-drift the matcher
 * actually experiences in production.
 *
 * The matcher (rewritten in migration 0023) uses greatest(seed_sim, learned_sim),
 * so subscriptions with no learned centroid behave exactly as before.
 */
import { createServerClient } from '@agent-crm/db';
import { inngest } from '../client.ts';

const WINDOW_MIN = 35;  // 5min overlap with the 30-min cron so we don't drop edges
const EMA_ALPHA = 0.2;

interface DispatchPayload {
  behavior?: string;
  ok?: boolean;
  facts_asserted?: number;
  signal_id?: string | null;
  subscription_id?: string | null;
}

interface SubRow {
  id: string;
  learned_centroid: string | null;       // pgvector returns as string '[0.1,0.2,...]'
  learned_positive_count: number | null;
}

function parseVec(s: string | null): number[] | null {
  if (!s) return null;
  try {
    // pgvector returns either a JSON-ish array or a "[a,b,c]" string.
    const trimmed = s.trim().replace(/^\[|\]$/g, '');
    if (!trimmed) return null;
    return trimmed.split(',').map((x) => Number(x.trim()));
  } catch { return null; }
}

function blendEMA(prev: number[], next: number[], alpha: number): number[] {
  const out = new Array<number>(prev.length);
  for (let i = 0; i < prev.length; i++) out[i] = (prev[i]! * (1 - alpha)) + (next[i]! * alpha);
  return out;
}

function toVecLit(v: number[]): string {
  return `[${v.join(',')}]`;
}

export const subscriptionDriftLearner = inngest.createFunction(
  { id: 'subscription-drift-learner' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    return await step.run('drift-update', async () => {
      const sb = createServerClient();
      const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();

      // Pull positives across all workspaces in one go; group later.
      const evRes = await sb.from('events')
        .select('workspace_id, payload')
        .eq('action', 'agent_dispatch_result')
        .gte('created_at', since)
        .limit(5000);
      if (evRes.error) throw new Error(`events: ${evRes.error.message}`);

      // Group: subscription_id → list of signal_ids
      const positives = new Map<string, { workspace_id: string; signal_ids: string[] }>();
      for (const e of (evRes.data ?? []) as Array<{ workspace_id: string; payload: DispatchPayload | null }>) {
        const p = e.payload;
        if (!p || p.behavior !== 'enricher' || !p.ok) continue;
        if ((p.facts_asserted ?? 0) < 1) continue;
        if (!p.subscription_id || !p.signal_id) continue;
        const cur = positives.get(p.subscription_id) ?? { workspace_id: e.workspace_id, signal_ids: [] };
        cur.signal_ids.push(p.signal_id);
        positives.set(p.subscription_id, cur);
      }

      if (positives.size === 0) return { subscriptions_updated: 0, positives_processed: 0 };

      // Bulk-load subscriptions, then per-subscription bulk-load signal embeddings.
      const subIds = [...positives.keys()];
      const subRes = await sb.from('subscriptions').select('id, learned_centroid, learned_positive_count').in('id', subIds);
      const subById = new Map<string, SubRow>();
      for (const s of (subRes.data ?? []) as SubRow[]) subById.set(s.id, s);

      let subscriptions_updated = 0;
      let positives_processed = 0;

      for (const [subId, { signal_ids }] of positives) {
        const sub = subById.get(subId);
        if (!sub) continue;
        const sigRes = await sb.from('signals').select('id, embedding').in('id', signal_ids);
        if (sigRes.error || !sigRes.data || sigRes.data.length === 0) continue;

        let centroid = parseVec(sub.learned_centroid);
        let count = sub.learned_positive_count ?? 0;

        for (const row of sigRes.data as Array<{ id: string; embedding: string | null }>) {
          const v = parseVec(row.embedding);
          if (!v) continue;
          if (centroid == null) {
            // First positive — seed the centroid with the signal embedding directly.
            centroid = v;
          } else {
            centroid = blendEMA(centroid, v, EMA_ALPHA);
          }
          count += 1;
          positives_processed += 1;
        }

        if (centroid == null) continue;
        const upd = await sb.from('subscriptions').update({
          learned_centroid: toVecLit(centroid),
          learned_positive_count: count,
          learned_updated_at: new Date().toISOString(),
        }).eq('id', subId);
        if (upd.error) {
          console.error(`subscription_drift: update ${subId} failed: ${upd.error.message}`);
          continue;
        }
        subscriptions_updated += 1;
      }

      return { subscriptions_updated, positives_processed };
    });
  },
);
