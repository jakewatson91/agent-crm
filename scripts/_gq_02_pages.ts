/**
 * Step 2: what pages did research actually buy, and what did each one yield?
 * One line per research_result signal: angle, hook class, published date,
 * URL, and the facts the enricher pulled off it.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 7);
const SHOW_FACTS = process.argv.includes('--facts');

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const sigs = (await sb.from('signals')
    .select('id, entity_id, observed_at, magnitude, structured_tags, body_for_embedding')
    .eq('workspace_id', WS).eq('type', 'research_result').gte('observed_at', since)
    .order('observed_at', { ascending: false }).limit(500)).data ?? [];
  const entIds = [...new Set(sigs.map((s) => s.entity_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < entIds.length; i += 400) {
    const r = await sb.from('entities').select('id, name').in('id', entIds.slice(i, i + 400));
    for (const e of r.data ?? []) names.set(e.id, e.name);
  }
  const factsBySig = new Map<string, any[]>();
  const sigIds = sigs.map((s) => s.id);
  for (let i = 0; i < sigIds.length; i += 400) {
    const r = await sb.from('facts').select('id, signal_id, predicate, object_text, confidence').in('signal_id', sigIds.slice(i, i + 400));
    for (const f of r.data ?? []) { if (!factsBySig.has(f.signal_id)) factsBySig.set(f.signal_id, []); factsBySig.get(f.signal_id)!.push(f); }
  }

  const byAngle = new Map<string, { n: number; facts: number; zero: number }>();
  const byClass = new Map<string, { n: number; facts: number; zero: number }>();
  const hostCount = new Map<string, number>();

  console.log(`research_result signals last ${DAYS}d: ${sigs.length}\n`);
  for (const s of sigs) {
    const t = s.structured_tags ?? {};
    const fs = factsBySig.get(s.id) ?? [];
    const angle = t.research_angle ?? '-';
    const cls = t.hook_class ?? 'unclassified';
    const a = byAngle.get(angle) ?? { n: 0, facts: 0, zero: 0 }; a.n++; a.facts += fs.length; if (!fs.length) a.zero++; byAngle.set(angle, a);
    const c = byClass.get(cls) ?? { n: 0, facts: 0, zero: 0 }; c.n++; c.facts += fs.length; if (!fs.length) c.zero++; byClass.set(cls, c);
    let host = '-'; try { host = new URL(t.url ?? '').hostname.replace(/^www\./, ''); } catch { /* */ }
    hostCount.set(host, (hostCount.get(host) ?? 0) + 1);
    if (SHOW_FACTS) {
      console.log(`[${(names.get(s.entity_id) ?? '?').slice(0, 24).padEnd(24)}] ${angle.padEnd(18)} ${cls.padEnd(10)} pub=${(t.published_at ?? 'none').slice(0, 10).padEnd(10)} mag=${Number(s.magnitude ?? 0).toFixed(2)} facts=${String(fs.length).padStart(2)}  ${t.url}`);
      for (const f of fs) console.log(`        · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 110)}`);
    }
  }

  console.log('\n=== by angle ===');
  for (const [k, v] of [...byAngle.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(22)} pages=${String(v.n).padStart(4)}  facts=${String(v.facts).padStart(4)}  facts/page=${(v.facts / v.n).toFixed(1)}  zero-fact pages=${v.zero} (${((v.zero / v.n) * 100).toFixed(0)}%)`);
  console.log('\n=== by hook class ===');
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(14)} pages=${String(v.n).padStart(4)}  facts=${String(v.facts).padStart(4)}  facts/page=${(v.facts / v.n).toFixed(1)}  zero-fact=${v.zero}`);
  console.log('\n=== top hosts ===');
  for (const [k, v] of [...hostCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(v).padStart(4)}  ${k}`);
})();
