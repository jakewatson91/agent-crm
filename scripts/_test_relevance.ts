/**
 * Test: re-emit ATS signals after clearing seen-jobs cache, then check
 * which signals matched the relevance subscription via the match_signal RPC.
 *
 * Doesn't need to wait for Inngest pipeline — we call match_signal_to_subscriptions
 * directly to see what would route, no enricher run.
 */
import { createServerClient } from '@agent-crm/db';
import ats from '../inngest/functions/sources/connectors/ats';
import type { ConnectorContext } from '../inngest/functions/sources/types';

const WS_ID = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const SUB_OWNER = 'relevant_hires_enricher';

async function main() {
  const sb = createServerClient();

  // 1. Clear ats_seen_jobs on the 15 entities that have a positive ATS hint,
  //    so the connector re-emits all jobs as signals.
  const probed = await sb.from('entities').select('id, name, attributes')
    .eq('workspace_id', WS_ID).not('attributes->ats', 'is', null).limit(100);
  const positives = (probed.data ?? []).filter((e) => (e.attributes as any)?.ats?.provider !== 'none');
  console.log(`positive-ATS entities to re-test: ${positives.length}`);
  for (const e of positives) {
    const attrs = { ...(e.attributes as any) };
    delete attrs.ats_seen_jobs;
    await sb.from('entities').update({ attributes: attrs }).eq('id', e.id);
  }

  const tStart = new Date().toISOString();

  // 2. Run ATS connector
  const src = await sb.from('sources').select('id, config')
    .eq('workspace_id', WS_ID).eq('connector_type', 'ats').maybeSingle();
  const ctx: ConnectorContext = {
    supabase: sb,
    workspace_id: WS_ID,
    source_id: src.data!.id as string,
    config: { ...(src.data!.config as Record<string, unknown>), max_entities_per_run: 30 },
    last_run_at: null,
  };
  const r = await ats(ctx);
  console.log(`\nATS run: signals=${r.signals_created} errors=${r.errors.length} skipped=${r.skipped}`);
  for (const e of r.errors.slice(0, 12)) console.log('  err:', e);

  // 3. Check each new signal against the match RPC
  const sigs = await sb.from('signals').select('id, entity_id, type, body_for_embedding')
    .eq('workspace_id', WS_ID).eq('type', 'hiring_post').gte('observed_at', tStart);
  console.log(`\nsignals created: ${sigs.data?.length ?? 0}`);

  // Get our subscription id for filtering
  const sub = await sb.from('subscriptions').select('id, threshold').eq('workspace_id', WS_ID).eq('owner_id', SUB_OWNER).maybeSingle();
  const subId = sub.data?.id as string;
  const subThreshold = sub.data?.threshold as number;
  console.log(`subscription id: ${subId} threshold: ${subThreshold}`);

  // Temporarily drop threshold to 0 to see actual cosines for all signals,
  // then restore. Diagnostic only — production threshold stays at 0.5.
  await sb.from('subscriptions').update({ threshold: 0 }).eq('id', subId);
  const rows: Array<{ entity: string; title: string; sim: number; passes: boolean }> = [];
  for (const s of sigs.data ?? []) {
    const ent = await sb.from('entities').select('name').eq('id', s.entity_id).maybeSingle();
    const m = await sb.rpc('match_signal_to_subscriptions', { p_signal_id: s.id });
    const ourMatch = (m.data ?? []).find((row: any) => row.subscription_id === subId);
    const sim = ourMatch ? Number(ourMatch.similarity) : NaN;
    const titleMatch = (s.body_for_embedding ?? '').match(/is hiring: ([^.\n(]+)/);
    const title = titleMatch?.[1]?.trim() ?? s.body_for_embedding.slice(0, 60);
    rows.push({ entity: ent.data?.name ?? '?', title, sim, passes: sim >= subThreshold });
  }
  await sb.from('subscriptions').update({ threshold: subThreshold }).eq('id', subId);
  rows.sort((a, b) => (b.sim || 0) - (a.sim || 0));

  const matched = rows.filter((r) => r.passes).length;
  console.log(`\nMATCHED at threshold ${subThreshold}: ${matched}/${rows.length}`);
  console.log('\nAll signals ranked by cosine:');
  for (const r of rows) console.log(`  ${r.passes ? '✓' : '·'} ${Number.isFinite(r.sim) ? r.sim.toFixed(3) : '????'} ${r.entity.padEnd(20)} ${r.title}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
