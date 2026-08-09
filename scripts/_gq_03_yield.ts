/**
 * Step 3: take the facts research produced recently and walk BACK to the page
 * that produced them. Shows the page → facts mapping the drafter will read,
 * so "was this page worth buying" is answerable per page.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 7);

async function fetchAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0; const pg = 1000;
  for (;;) { const { data, error } = await build(f, f + pg - 1); if (error) throw error; if (!data?.length) break; out = out.concat(data); if (data.length < pg) break; f += pg; }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const facts = await fetchAll<any>((f, t) => sb.from('facts')
    .select('id, predicate, object_text, confidence, signal_id, subject_entity, created_at')
    .eq('workspace_id', WS).gte('created_at', since).not('signal_id', 'is', null)
    .order('created_at', { ascending: false }).range(f, t));

  const sigIds = [...new Set(facts.map((f) => f.signal_id))];
  const sigs = new Map<string, any>();
  for (let i = 0; i < sigIds.length; i += 400) {
    const r = await sb.from('signals').select('id, type, entity_id, structured_tags, observed_at, magnitude').in('id', sigIds.slice(i, i + 400));
    for (const s of r.data ?? []) sigs.set(s.id, s);
  }
  const entIds = [...new Set([...sigs.values()].map((s) => s.entity_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < entIds.length; i += 400) {
    const r = await sb.from('entities').select('id, name').in('id', entIds.slice(i, i + 400));
    for (const e of r.data ?? []) names.set(e.id, e.name);
  }

  const byPage = new Map<string, { sig: any; facts: any[] }>();
  for (const f of facts) {
    const s = sigs.get(f.signal_id); if (!s || s.type !== 'research_result') continue;
    if (!byPage.has(f.signal_id)) byPage.set(f.signal_id, { sig: s, facts: [] });
    byPage.get(f.signal_id)!.facts.push(f);
  }
  const pages = [...byPage.values()].sort((a, b) => b.facts.length - a.facts.length);
  console.log(`research pages that produced facts in the last ${DAYS}d: ${pages.length}, total facts ${pages.reduce((n, p) => n + p.facts.length, 0)}\n`);
  for (const p of pages) {
    const t = p.sig.structured_tags ?? {};
    console.log(`### ${names.get(p.sig.entity_id) ?? '?'}  |  angle=${t.research_angle} class=${t.hook_class ?? '-'} pub=${(t.published_at ?? 'none').slice(0, 10)} facts=${p.facts.length}`);
    console.log(`    ${t.url}`);
    for (const f of p.facts) console.log(`      · ${f.predicate} = ${String(f.object_text ?? '').slice(0, 120)}`);
  }
})();
