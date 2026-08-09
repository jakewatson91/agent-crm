/**
 * Step 5: is the relevance gate's LLM response being truncated?
 *
 * Hypothesis: research batches EVERY angle's candidates into ONE
 * filterResultsByEntity call (up to 5 angles x 10 results = 50 pages), and asks
 * the model to echo every page id back in matches[] + rejects[]. Exa ids are
 * long. max_tokens is 1200. If the response truncates, JSON.parse throws, the
 * catch fires, and every own-domain page is accepted with NO hook class while
 * every off-domain page is dropped as "unreported".
 *
 * The event log's own numbers are the tell: unclassified accepts and unreported
 * drops should both be near zero if the gate is working.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 7);

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const ev = ((await sb.from('events').select('payload, target_id, created_at')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(2000)).data ?? []) as any[];

  // A run is "gate blew up" when every drop it recorded is unreported AND it
  // dropped something. A run is "gate answered" when a named bucket is non-zero.
  let blew = 0, answered = 0, nodrops = 0;
  let blewCandidates = 0, answeredCandidates = 0;
  const rows: any[] = [];
  for (const e of ev) {
    const d = e.payload ?? {};
    const fb = d.filtered_by ?? {};
    const named = (fb.identity ?? 0) + (fb.substance ?? 0) + (fb.relevance ?? 0);
    const unrep = fb.unreported ?? 0;
    const created = d.results_created ?? 0;
    const gateSaw = named + unrep + created; // pages that reached the LLM gate
    if (gateSaw === 0) { nodrops++; continue; }
    if (unrep > 0 && named === 0) { blew++; blewCandidates += gateSaw; }
    else { answered++; answeredCandidates += gateSaw; }
    rows.push({ gateSaw, named, unrep, created, cls: d.per_class ?? {} });
  }
  console.log(`runs in window: ${ev.length}`);
  console.log(`  gate ANSWERED (a named reject bucket is non-zero): ${answered}  — pages seen: ${answeredCandidates}`);
  console.log(`  gate BLEW UP  (drops exist, all unreported):       ${blew}  — pages seen: ${blewCandidates}`);
  console.log(`  nothing reached the gate:                          ${nodrops}`);

  // Batch size is the suspect. Bucket the blow-ups by how many pages the gate was handed.
  const bucket = (n: number) => n <= 5 ? '01-05' : n <= 10 ? '06-10' : n <= 20 ? '11-20' : n <= 30 ? '21-30' : n <= 40 ? '31-40' : '41+';
  const tab = new Map<string, { blew: number; ok: number }>();
  for (const r of rows) {
    const b = bucket(r.gateSaw);
    const t = tab.get(b) ?? { blew: 0, ok: 0 };
    if (r.unrep > 0 && r.named === 0) t.blew++; else t.ok++;
    tab.set(b, t);
  }
  console.log('\n=== blow-up rate by how many pages the gate was handed in one call ===');
  for (const b of ['01-05', '06-10', '11-20', '21-30', '31-40', '41+']) {
    const t = tab.get(b); if (!t) continue;
    const n = t.blew + t.ok;
    console.log(`  pages ${b.padEnd(6)} runs=${String(n).padStart(4)}  blew=${String(t.blew).padStart(4)} (${((t.blew / n) * 100).toFixed(0)}%)`);
  }

  // What the accepted signals look like: unclassified == the gate never judged it.
  const cls: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.cls)) cls[k] = (cls[k] ?? 0) + (v as number);
  const tot = Object.values(cls).reduce((a, b) => a + b, 0);
  console.log('\n=== hook class on every signal created in the window ===');
  for (const [k, v] of Object.entries(cls).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  ${((v / tot) * 100).toFixed(0)}%`);
})();
