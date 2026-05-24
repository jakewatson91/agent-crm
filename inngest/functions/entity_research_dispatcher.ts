/**
 * Score-tiered research dispatcher.
 *
 * Every 4h, walks every account entity and decides whether enough time has
 * elapsed since the last research run to merit another. Tier determines
 * cadence; tier is driven by score_total (rolled-up ICP+signal score) with
 * score_signal_strength as an independent override and engagement as a
 * second override.
 *
 *   Hot     — score_total ≥ 0.5 OR signal_strength ≥ 0.7 OR engaged → every 24h
 *   Default — score_total ∈ [0.3, 0.5) → every 7d
 *   Cold    — score_total < 0.3       → every 30d
 *   Suppressed — dropped_until in the future → never
 *
 * Reuses the existing `research.requested` event consumed by researchRunner.
 * No schema changes. Writes `research_triggered` (same predicate the reactive
 * action_selector path uses) as the dispatch marker so subsequent ticks see
 * the cooldown even before researchRunner finishes.
 */
import { createServerClient } from '@agent-crm/db';
import { callTool, entityIdsOfType } from '@agent-crm/tools';
import { inngest } from '../client.js';

const TIER_CADENCE_HOURS = { hot: 24, default: 24 * 7, cold: 24 * 30 } as const;
const HOT_ICP_THRESHOLD = 0.5;
const HOT_SIGNAL_THRESHOLD = 0.7;
const COLD_ICP_THRESHOLD = 0.3;
const ENGAGEMENT_WINDOW_DAYS = 14;
const RESEARCH_FANOUT_LIMIT = 25;

type Tier = 'hot' | 'default' | 'cold';

interface Candidate {
  workspace_id: string;
  entity_id: string;
  entity_name: string;
  tier: Tier;
  last_research_at: number; // epoch ms; 0 if never
}

export const entityResearchDispatcher = inngest.createFunction(
  { id: 'entity-research-dispatcher' },
  { cron: '0 */4 * * *' },
  async ({ step }) => {
    const summary = await step.run('dispatch-batch', async () => {
      const supabase = createServerClient();
      const now = Date.now();
      const engagementSince = new Date(now - ENGAGEMENT_WINDOW_DAYS * 86400 * 1000).toISOString();

      const wsRes = await supabase.from('workspaces').select('id');
      const workspaces = (wsRes.data ?? []) as Array<{ id: string }>;

      const candidates: Candidate[] = [];
      let total_evaluated = 0;
      let skipped_suppressed = 0;

      for (const ws of workspaces) {
        const allAcctIds = (await entityIdsOfType(supabase, ws.id, 'account')).slice(0, 5000);
        const acctRes = allAcctIds.length === 0
          ? { data: [] as Array<{ id: string; name: string }> }
          : await supabase
              .from('entities').select('id, name')
              .in('id', allAcctIds);
        const accounts = (acctRes.data ?? []) as Array<{ id: string; name: string }>;
        if (!accounts.length) continue;
        total_evaluated += accounts.length;
        const acctIds = accounts.map((a) => a.id);

        // Batched fact load — every predicate we care about, in one query.
        // Active facts only (supersedes is null).
        const factRes = await supabase
          .from('facts')
          .select('subject_entity, predicate, object_text, observed_at')
          .eq('workspace_id', ws.id)
          .in('subject_entity', acctIds)
          .in('predicate', [
            'icp_fit', 'score_total', 'score_signal_strength', 'dropped_until',
            'research_triggered', 'research_completed',
          ])
          .is('supersedes', null);

        interface EntityState {
          score_total: number | null;
          signal_strength: number | null;
          dropped_until: string | null;
          last_research_at: number;
        }
        const stateByEntity = new Map<string, EntityState>();
        for (const a of accounts) {
          stateByEntity.set(a.id, { score_total: null, signal_strength: null, dropped_until: null, last_research_at: 0 });
        }
        for (const f of (factRes.data ?? []) as Array<{ subject_entity: string; predicate: string; object_text: string | null; observed_at: string }>) {
          const s = stateByEntity.get(f.subject_entity);
          if (!s) continue;
          const ts = Date.parse(f.observed_at);
          if (f.predicate === 'score_total') {
            const v = parseFloat(f.object_text ?? '');
            if (Number.isFinite(v)) s.score_total = v;
          } else if (f.predicate === 'icp_fit') {
            // Fallback only — prefer score_total if it ever sets above.
            if (s.score_total === null) {
              const v = parseFloat(f.object_text ?? '');
              if (Number.isFinite(v)) s.score_total = v;
            }
          } else if (f.predicate === 'score_signal_strength') {
            const v = parseFloat(f.object_text ?? '');
            if (Number.isFinite(v)) s.signal_strength = v;
          } else if (f.predicate === 'dropped_until') {
            s.dropped_until = f.object_text ?? null;
          } else if (f.predicate === 'research_triggered' || f.predicate === 'research_completed') {
            if (Number.isFinite(ts) && ts > s.last_research_at) s.last_research_at = ts;
          }
        }

        // Engagement detection: open touch_draft/outcome posts, approved gates,
        // replied touches — all within the engagement window. Result is a Set
        // of account entity IDs considered "actively engaged."
        const engaged = new Set<string>();

        const chanRes = await supabase
          .from('channels').select('id, account_entity_id')
          .eq('workspace_id', ws.id).in('account_entity_id', acctIds);
        const channels = (chanRes.data ?? []) as Array<{ id: string; account_entity_id: string }>;
        const entityByChannel = new Map(channels.map((c) => [c.id, c.account_entity_id]));
        const channelIds = channels.map((c) => c.id);

        if (channelIds.length) {
          // touch_draft / outcome posts
          const postRes = await supabase
            .from('channel_posts').select('channel_id, id, kind, created_at')
            .in('channel_id', channelIds)
            .in('kind', ['touch_draft', 'outcome'])
            .gte('created_at', engagementSince);
          const engagementPosts = (postRes.data ?? []) as Array<{ channel_id: string; id: string }>;
          for (const p of engagementPosts) {
            const eid = entityByChannel.get(p.channel_id);
            if (eid) engaged.add(eid);
          }

          // Approved gates referencing posts on these channels.
          // Two-step: posts on channels → gates against those post ids.
          const allPostsRes = await supabase
            .from('channel_posts').select('id, channel_id').in('channel_id', channelIds);
          const allPosts = (allPostsRes.data ?? []) as Array<{ id: string; channel_id: string }>;
          if (allPosts.length) {
            const postToChannel = new Map(allPosts.map((p) => [p.id, p.channel_id]));
            const gateRes = await supabase
              .from('gates').select('channel_post_id, decision, decided_at')
              .in('channel_post_id', allPosts.map((p) => p.id))
              .eq('decision', 'approve')
              .gte('decided_at', engagementSince);
            for (const g of (gateRes.data ?? []) as Array<{ channel_post_id: string }>) {
              const cid = postToChannel.get(g.channel_post_id);
              const eid = cid ? entityByChannel.get(cid) : undefined;
              if (eid) engaged.add(eid);
            }
          }
        }

        // Replied touches → walk works_at facts to map contact_entity_id → account_entity_id.
        const touchRes = await supabase
          .from('touches').select('contact_entity_id, status, sent_at')
          .eq('workspace_id', ws.id).eq('status', 'replied')
          .gte('sent_at', engagementSince);
        const repliedContacts = ((touchRes.data ?? []) as Array<{ contact_entity_id: string }>)
          .map((t) => t.contact_entity_id);
        if (repliedContacts.length) {
          const worksAtRes = await supabase
            .from('facts').select('subject_entity, object_entity')
            .eq('workspace_id', ws.id).eq('predicate', 'works_at')
            .is('supersedes', null).in('subject_entity', repliedContacts);
          for (const f of (worksAtRes.data ?? []) as Array<{ object_entity: string | null }>) {
            if (f.object_entity && stateByEntity.has(f.object_entity)) engaged.add(f.object_entity);
          }
        }

        // Tier each entity and enqueue if cooldown elapsed.
        for (const a of accounts) {
          const s = stateByEntity.get(a.id)!;
          if (s.dropped_until) {
            const until = Date.parse(s.dropped_until);
            if (Number.isFinite(until) && until > now) { skipped_suppressed++; continue; }
          }
          let tier: Tier;
          if (engaged.has(a.id) || (s.signal_strength ?? 0) >= HOT_SIGNAL_THRESHOLD || (s.score_total ?? 0) >= HOT_ICP_THRESHOLD) {
            tier = 'hot';
          } else if ((s.score_total ?? 0) >= COLD_ICP_THRESHOLD) {
            tier = 'default';
          } else {
            tier = 'cold';
          }
          const cadenceMs = TIER_CADENCE_HOURS[tier] * 3600 * 1000;
          if (s.last_research_at && now - s.last_research_at < cadenceMs) continue;
          candidates.push({
            workspace_id: ws.id, entity_id: a.id, entity_name: a.name,
            tier, last_research_at: s.last_research_at,
          });
        }
      }

      // Priority: Hot before Default before Cold; within tier, oldest-research-first
      // (so an entity that's been dormant longest gets the slot before one researched yesterday).
      const tierOrder = { hot: 0, default: 1, cold: 2 } as const;
      candidates.sort((a, b) => {
        const t = tierOrder[a.tier] - tierOrder[b.tier];
        if (t !== 0) return t;
        return a.last_research_at - b.last_research_at;
      });
      const chosen = candidates.slice(0, RESEARCH_FANOUT_LIMIT);
      const skipped_capped = candidates.length - chosen.length;

      const by_tier = { hot: 0, default: 0, cold: 0 };
      let dispatch_errors = 0;
      for (const c of chosen) {
        by_tier[c.tier]++;
        const actor = { workspace_id: c.workspace_id, actor_kind: 'system' as const, actor_id: 'entity_research_dispatcher' };
        try {
          // Dispatch marker — reuses the same predicate the reactive path uses
          // so action_selector's cooldown read picks this up too.
          await callTool(supabase, actor, 'assert_fact', {
            subject_entity: c.entity_id,
            predicate: 'research_triggered',
            object_text: new Date().toISOString(),
            confidence: 1.0,
          });
          await inngest.send({
            name: 'research.requested',
            data: {
              workspace_id: c.workspace_id,
              entity_id: c.entity_id,
              entity_name: c.entity_name,
              reason: `dispatcher:${c.tier}`,
            },
          });
        } catch {
          dispatch_errors++;
        }
      }

      return {
        dispatched: chosen.length - dispatch_errors,
        by_tier,
        total_evaluated,
        due: candidates.length,
        skipped_capped,
        skipped_suppressed,
        dispatch_errors,
      };
    });

    return summary;
  },
);
