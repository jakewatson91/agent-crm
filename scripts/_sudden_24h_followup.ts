import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const since24h = new Date(Date.now() - 24 * 3600e3).toISOString();

async function main() {
  // enrichment_skipped reasons
  const { data: skips } = await sb.from('events').select('created_at, payload')
    .eq('workspace_id', WS).eq('action', 'enrichment_skipped').gte('created_at', since24h)
    .order('created_at', { ascending: false }).limit(1000);
  const reasons = new Map<string, number>();
  for (const e of skips ?? []) {
    const p = e.payload as Record<string, unknown> | null;
    const r = String(p?.reason ?? p?.why ?? JSON.stringify(p)?.slice(0, 60));
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  console.log(`=== enrichment_skipped reasons (${skips?.length}) ===`);
  for (const [r, n] of [...reasons.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${n}×  ${r}`);

  // sources (no kind column)
  const { data: srcs, error: srcErr } = await sb.from('sources').select('id, name, active, config').eq('workspace_id', WS);
  console.log(`\n=== sources (err=${srcErr?.message ?? 'none'}) ===`);
  for (const s of srcs ?? []) {
    const cfg = s.config as Record<string, unknown> | null;
    console.log(`  ${s.name} active=${s.active} cfg_keys=[${cfg ? Object.keys(cfg).join(',') : ''}]`);
    console.log(`    cron=${cfg?.cron ?? '-'} last_run_at=${cfg?.last_run_at ?? '-'} paused=${cfg?.paused ?? '-'} connector=${cfg?.connector ?? cfg?.provider ?? '-'}`);
  }

  // gates full detail
  const { data: gates, error: gErr } = await sb.from('gates').select('*').eq('workspace_id', WS).order('requested_at', { ascending: false }).limit(10);
  console.log(`\n=== gates (err=${gErr?.message ?? 'none'}) ===`);
  for (const g of gates ?? []) {
    const keys = Object.keys(g);
    console.log(`  ${JSON.stringify(g)?.slice(0, 400)}`);
    if (g === (gates ?? [])[0]) console.log(`  [columns: ${keys.join(', ')}]`);
  }

  // scores written last 24h — what values
  const { data: newScores } = await sb.from('facts').select('object_text, observed_at, subject_entity')
    .eq('workspace_id', WS).eq('predicate', 'score_total').gte('observed_at', since24h).order('observed_at', { ascending: false });
  const vc = new Map<string, number>();
  for (const f of newScores ?? []) vc.set(f.object_text, (vc.get(f.object_text) ?? 0) + 1);
  console.log(`\n=== score_total written last 24h (${newScores?.length}) ===`);
  console.log('  values:', [...vc.entries()].sort((x, y) => y[1] - x[1]).map(([v, n]) => `${v}×${n}`).join('  '));

  // one icp_fit_breakdown sample
  const { data: bd } = await sb.from('facts').select('object_text, object_json, subject_entity, observed_at')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit_breakdown').gte('observed_at', since24h).limit(2);
  console.log(`\n=== icp_fit_breakdown samples ===`);
  for (const b of bd ?? []) console.log(`  ${b.observed_at}  ${(b.object_text ?? JSON.stringify(b.object_json))?.slice(0, 500)}`);

  // outreach_stage values last 24h
  const { data: stages } = await sb.from('facts').select('object_text, observed_at, subject_entity')
    .eq('workspace_id', WS).eq('predicate', 'outreach_stage').gte('observed_at', since24h);
  console.log(`\n=== outreach_stage facts last 24h (${stages?.length}) ===`);
  const sc = new Map<string, number>();
  for (const s of stages ?? []) sc.set(s.object_text, (sc.get(s.object_text) ?? 0) + 1);
  for (const [v, n] of sc.entries()) console.log(`  ${v}: ${n}`);

  // contact counts
  const contactTotal = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate', 'is_a').eq('object_text', 'contact');
  const accountTotal = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate', 'is_a').eq('object_text', 'account');
  const emailFacts = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate', 'email');
  console.log(`\n=== totals: accounts=${accountTotal.count} contacts=${contactTotal.count} email_facts=${emailFacts.count} ===`);

  // the one request_gate + drafter_shortlist_pick events
  const { data: draftEv } = await sb.from('events').select('action, created_at, payload')
    .eq('workspace_id', WS).in('action', ['request_gate', 'drafter_shortlist_pick', 'action_selector_skip'])
    .gte('created_at', since24h).order('created_at', { ascending: false });
  console.log(`\n=== drafter-path events ===`);
  for (const e of draftEv ?? []) console.log(`  ${e.created_at}  ${e.action}  ${JSON.stringify(e.payload)?.slice(0, 300)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
