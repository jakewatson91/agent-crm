/**
 * Rescore one account, once, after its facts stop arriving.
 *
 * The enricher used to call scoreAndAssert inline on every run that asserted a
 * fact. Research reaches it one article at a time, so an account in a research
 * burst was scored once per article. Measured over one week on the Sudden book:
 * 286 of 441 rubric calls (1.32M tokens) were repeat calls on an account already
 * scored inside the previous 60 minutes. One account took 28 rubric calls, 22 of
 * the 27 gaps between them under five minutes, and every number but the last was
 * superseded before anything read it.
 *
 * The score is a pure function of the account's facts, so only the last one in a
 * burst is worth paying for. Debouncing on entity_id gets exactly that: each new
 * request restarts the timer, and the rubric runs once, when the account goes
 * quiet, against the complete fact set. That also makes the surviving score more
 * honest than any of the ones it replaces, which were each computed on a partial
 * view of the same burst.
 *
 * `timeout` is what stops a steady drip from pushing the score back forever: no
 * matter how long the requests keep coming, the rubric runs within 30 minutes of
 * the first one.
 *
 * Enrichment itself is deliberately NOT batched here. A later run in a burst
 * asserts the same 1.2 facts on average as the first one, because each run is
 * reading a different article, and every fact stays bound to the signal it came
 * from (facts.signal_id is the cite chain). This defers the scoring only.
 */
import { createServerClient } from '@agent-crm/db';
import { callTool, scoreAndAssert, currentFactRows, fetchAll } from '@agent-crm/tools';
import { inngest } from '../client.ts';
import { icpBand } from './agent_logic.ts';

/**
 * Exported so scripts/check_rescore_debounce.ts can pin it. The key is the part
 * that matters: keyed on workspace_id instead of entity_id, one busy account
 * would swallow every other account's rescore in the same workspace and the
 * book would silently stop being scored.
 */
export const RESCORE_DEBOUNCE = {
  key: 'event.data.entity_id',
  period: '10m',
  timeout: '30m',
} as const;

export const rescoreEntity = inngest.createFunction(
  {
    id: 'rescore-entity',
    debounce: RESCORE_DEBOUNCE,
    concurrency: { limit: 5, key: 'event.data.workspace_id' },
  },
  { event: 'entity.rescore_requested' },
  async ({ event, step }) => {
    return await step.run('rescore', async () => {
      const supabase = createServerClient();
      const { workspace_id, entity_id } = event.data;
      const actor = { workspace_id, actor_kind: 'system' as const, actor_id: 'scorer' };

      // The score before this run, read the only way that is correct: the row no
      // other row supersedes, newest observed_at among those. `.is('supersedes',
      // null)` returns the ORIGINAL of the chain and has shipped as a bug three
      // times in this repo.
      const priorRows = await fetchAll<{ id: string; object_text: string | null; observed_at: string; supersedes: string | null }>(
        (from, to) => supabase.from('facts')
          .select('id, object_text, observed_at, supersedes')
          .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
          .eq('predicate', 'icp_fit')
          .order('observed_at', { ascending: false }).order('id').range(from, to),
      );
      const priorText = currentFactRows(priorRows, () => 'icp_fit').get('icp_fit')?.object_text;
      const priorScore = priorText ? parseFloat(priorText) : NaN;

      // scoreAndAssert keeps its own guards: it returns null for a contact, a
      // candidate, a dropped account, or evidence that has not moved since the
      // current score. A null here is a correct no-op, not a failure.
      const score = await scoreAndAssert(supabase, actor, entity_id);
      if (!score) return { entity_id, scored: false, reason: 'no_score_written' };

      // Post the score reasoning only when the band moved, same rule the enricher
      // used to apply inline: the band is what maps to the action_selector
      // thresholds, so a band shift is the only score change that alters what
      // happens next. Once per burst now, instead of once per article.
      let band_posted = false;
      if (!Number.isFinite(priorScore) || icpBand(priorScore) !== icpBand(score.icp_fit)) {
        const chan = await supabase.from('channels').select('id')
          .eq('workspace_id', workspace_id).eq('account_entity_id', entity_id).maybeSingle();
        if (chan.data?.id) {
          const body = `ICP fit ${score.icp_fit.toFixed(2)} (${icpBand(score.icp_fit)}) — ${score.reasoning}`;
          const posted = await callTool(supabase, actor, 'post_to_channel', {
            channel_id: chan.data.id, kind: 'decision', body,
          });
          band_posted = posted.ok;
        }
      }

      return {
        entity_id,
        scored: true,
        icp_fit: score.icp_fit,
        prior: Number.isFinite(priorScore) ? priorScore : null,
        llm_called: score.llm_called,
        band_posted,
      };
    });
  },
);
