/**
 * The live failure is the enricher, not the page gate. Read the actual payloads.
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SINCE = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
(async () => {
  const { data } = await sb.from('events')
    .select('workspace_id, created_at, target_id, payload')
    .eq('action', 'agent_llm_failed').gte('created_at', SINCE)
    .order('created_at', { ascending: false }).limit(200);
  console.log(`payload keys seen: ${[...new Set((data ?? []).flatMap((d: any) => Object.keys(d.payload ?? {})))].join(', ')}\n`);
  const byDay = new Map<string, number>();
  for (const d of data ?? []) byDay.set(d.created_at.slice(0,10), (byDay.get(d.created_at.slice(0,10)) ?? 0) + 1);
  console.log('failures by day:');
  for (const [k,v] of [...byDay.entries()].sort()) console.log(`  ${k}  ${v}`);
  console.log('\n--- sample payloads (most recent 12) ---');
  for (const d of (data ?? []).slice(0, 12)) {
    console.log(`\n${d.created_at.slice(0,16)} ws=${String(d.workspace_id).slice(0,8)}`);
    console.log(JSON.stringify(d.payload).slice(0, 900));
  }
  // distinct error strings
  const errs = new Map<string, number>();
  for (const d of data ?? []) {
    const p: any = d.payload ?? {};
    const e = String(p.error ?? p.message ?? p.detail ?? '(no error field)').slice(0, 180);
    errs.set(e, (errs.get(e) ?? 0) + 1);
  }
  console.log('\n--- distinct error strings ---');
  for (const [e,n] of [...errs.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${n}x  ${e}`);
})();
