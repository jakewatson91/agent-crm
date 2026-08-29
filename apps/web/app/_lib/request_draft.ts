/**
 * ToolDeps.requestDraft — run the drafter over one account, now.
 *
 * Synchronous on purpose, unlike research. Research queues searches that land
 * minutes later, so "queued" is the only honest answer there. A draft is one
 * model call and the person asking is waiting on the result, including the case
 * where the result is a refusal. The refusal is the useful half: the nightly
 * pass computes exactly these reasons and discards them.
 *
 * Lives in the web app rather than in packages/tools because the drafter is in
 * the inngest project, which is downstream of tools. Imported lazily for the
 * same reason api/inngest/route.ts does it: the background-job module graph is
 * large and routes that never draft should not pay to compile it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export function makeRequestDraft(supabase: SupabaseClient) {
  return async function requestDraft(event: {
    workspace_id: string;
    entity_id: string;
    reason: string;
    force_argument_id?: string;
  }) {
    const { runAgent, pickTriggerFactId } = await import('@agent-crm/inngest/functions');

    // The drafter subscription's owner is the actor the run needs, and its id is
    // what pins behavior='drafter'. Missing one is a setup gap on this
    // workspace, not a fault of the account being asked about.
    const sub = (await supabase
      .from('subscriptions')
      .select('id, owner_id')
      .eq('workspace_id', event.workspace_id)
      .eq('agent_behavior', 'drafter')
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()).data as { id: string; owner_id: string } | null;
    if (!sub) return { ok: false, reason: 'no_drafter_configured' };

    // Same trigger the nightly pass uses: the freshest dated fact worth opening
    // on. No fact means there is nothing to say today, which is a real answer.
    const factId = await pickTriggerFactId(supabase, event.workspace_id, event.entity_id);
    if (!factId) return { ok: false, reason: 'no_writable_anchor' };

    const r = await runAgent(supabase, {
      workspace_id: event.workspace_id,
      agent: sub.owner_id,
      subscription_id: sub.id,
      fact_id: factId,
      ...(event.force_argument_id ? { force_argument_id: event.force_argument_id } : {}),
    });
    return {
      ok: r.ok,
      action: r.action,
      reason: r.reason,
      channel_post_id: r.channel_post_id,
      gate_id: r.gate_id,
    };
  };
}
