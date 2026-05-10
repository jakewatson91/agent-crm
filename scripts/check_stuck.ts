/**
 * Read-only health audit. Surfaces things that should have moved but didn't.
 *
 * Reports:
 *   1. Signals older than STALE_SIGNAL_MIN min with no downstream subscription.matched event
 *   2. Sources with last_run_status='error' (most recent run)
 *   3. Gate requests open longer than STALE_GATE_DAYS
 *   4. Drafts older than STALE_DRAFT_DAYS with no follow-up event
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const STALE_SIGNAL_MIN = 30;
const STALE_GATE_DAYS = 7;
const STALE_DRAFT_DAYS = 7;

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)}…)\n`);

  // 1. Stuck signals: created >30 min ago with no subscription.matched event for them
  console.log('=== UNMATCHED SIGNALS ===');
  const since = new Date(Date.now() - STALE_SIGNAL_MIN * 60 * 1000).toISOString();
  const sigsRes = await sb.from('signals')
    .select('id, type, created_at, body_for_embedding')
    .eq('workspace_id', WS)
    .lt('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);
  const signals = sigsRes.data ?? [];
  if (signals.length === 0) {
    console.log('  (no signals older than 30m)');
  } else {
    const sigIds = signals.map((s) => s.id);
    const matchedRes = await sb.from('events')
      .select('payload')
      .eq('workspace_id', WS)
      .eq('action', 'subscription.matched')
      .in('payload->>signal_id' as any, sigIds);
    const matchedIds = new Set<string>();
    for (const e of matchedRes.data ?? []) {
      const p = (e.payload ?? {}) as { signal_id?: string };
      if (p.signal_id) matchedIds.add(p.signal_id);
    }
    const unmatched = signals.filter((s) => !matchedIds.has(s.id));
    console.log(`  unmatched: ${unmatched.length} of ${signals.length} aged signals`);
    for (const s of unmatched.slice(0, 10)) {
      const body = (s.body_for_embedding as string | null)?.slice(0, 60) ?? '';
      console.log(`    [${s.type}] ${s.id.slice(0, 8)}… ${body}`);
    }
    if (unmatched.length > 10) console.log(`    … and ${unmatched.length - 10} more`);
  }

  // 2. Sources with most recent run = error
  console.log('\n=== SOURCES IN ERROR ===');
  const srcRes = await sb.from('sources')
    .select('id, name, connector_type, last_run_at, last_run_status, last_run_summary')
    .eq('workspace_id', WS)
    .eq('last_run_status', 'error')
    .order('last_run_at', { ascending: false });
  const errSources = srcRes.data ?? [];
  if (errSources.length === 0) {
    console.log('  (none)');
  } else {
    for (const s of errSources) {
      const errs = (s.last_run_summary as { errors?: string[] } | null)?.errors ?? [];
      console.log(`  ${s.connector_type.padEnd(10)} ${(s.name as string).padEnd(36)} ${(s.last_run_at as string)?.slice(5, 16) ?? ''}`);
      for (const e of errs.slice(0, 2)) console.log(`    ↳ ${e.slice(0, 120)}`);
    }
  }

  // 3. Open gates older than STALE_GATE_DAYS
  console.log('\n=== STALE GATES ===');
  const gateSince = new Date(Date.now() - STALE_GATE_DAYS * 86400000).toISOString();
  const gatesRes = await sb.from('events')
    .select('id, ts, payload')
    .eq('workspace_id', WS)
    .eq('action', 'request_gate')
    .lt('ts', gateSince)
    .order('ts', { ascending: false })
    .limit(50);
  const gates = gatesRes.data ?? [];
  // a gate is "decided" if there's a matching gate_decision event
  const decidedRes = await sb.from('events')
    .select('parent_event_id')
    .eq('workspace_id', WS)
    .eq('action', 'gate_decision');
  const decided = new Set<number>((decidedRes.data ?? []).map((d: any) => d.parent_event_id).filter(Boolean));
  const openStale = gates.filter((g) => !decided.has(g.id as number));
  if (openStale.length === 0) {
    console.log('  (none)');
  } else {
    console.log(`  ${openStale.length} open gate(s) older than ${STALE_GATE_DAYS}d`);
    for (const g of openStale.slice(0, 5)) {
      const policy = (g.payload as any)?.policy ?? '?';
      console.log(`    ${(g.ts as string).slice(5, 16)} policy=${policy}`);
    }
  }

  // 4. Drafts older than STALE_DRAFT_DAYS with no follow-up event in same channel
  console.log('\n=== STALE DRAFTS (no follow-up) ===');
  const draftSince = new Date(Date.now() - STALE_DRAFT_DAYS * 86400000).toISOString();
  const draftsRes = await sb.from('channel_posts')
    .select('id, channel_id, created_at, body')
    .eq('kind', 'touch_draft')
    .lt('created_at', draftSince)
    .order('created_at', { ascending: false })
    .limit(50);
  const drafts = draftsRes.data ?? [];
  if (drafts.length === 0) {
    console.log('  (no drafts older than 7d)');
  } else {
    const channelIds = [...new Set(drafts.map((d) => d.channel_id))];
    const followRes = await sb.from('channel_posts')
      .select('channel_id, created_at')
      .in('channel_id', channelIds)
      .gt('created_at', draftSince);
    const channelsWithFollowup = new Set<string>((followRes.data ?? []).map((p: any) => p.channel_id));
    const stale = drafts.filter((d) => !channelsWithFollowup.has(d.channel_id as string));
    if (stale.length === 0) {
      console.log('  (none — every old draft has follow-up)');
    } else {
      console.log(`  ${stale.length} draft(s) sat for >${STALE_DRAFT_DAYS}d with no follow-up`);
      for (const d of stale.slice(0, 5)) {
        const body = (d.body as string).slice(0, 80);
        console.log(`    ${(d.created_at as string).slice(5, 16)} ${body}…`);
      }
    }
  }

  console.log('\n---');
  console.log('done. re-run after each cron cycle to spot regressions.');
}
main().catch((e) => { console.error(e); process.exit(1); });
