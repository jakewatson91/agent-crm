/** MARKET SWEEP vs ACCOUNT PROBE.
 *
 * Today: one search asks "what happened to account X?" -> 46 searches per usable
 * reason, measured. Here: one search asks "what happened in this market this
 * week?" and every company named in the results is a candidate hit. Names are
 * extracted by the model (token matching gave false positives), then matched to
 * the book with the same normalisation the book uses.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchAll, getPolicy, resolveEnvVar, runExaSearch } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

// What a streaming-market sweep looks like: the EVENT, not the company.
const SWEEPS = [
  'streaming service launches new channel or app or market this week',
  'streaming platform announces subscriber milestone or record viewership',
  'streaming company expands distribution deal or carriage agreement',
  'OTT platform launches FAST channel or free ad supported tier',
  'streaming service enters new country or region',
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
  const policy: any = await getPolicy(sb, WS);
  const key = resolveEnvVar(policy, 'EXA_API_KEY')!;
  const ents = await fetchAll<any>((from, to) =>
    sb.from('entities').select('id, name').eq('workspace_id', WS).order('id', { ascending: true }).range(from, to));
  const book = new Map<string, string>();
  for (const e of ents) book.set(norm(e.name), e.name);
  console.log(`book: ${ents.length} accounts\n`);

  const since = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);
  let searches = 0;
  const allHits = new Map<string, { headline: string; date: string }>();

  for (const q of SWEEPS) {
    const res = await runExaSearch(key, { query: q, num_results: 25, type: 'auto', text_chars: 350, category: 'news', start_published_date: since });
    searches++;
    if (!res.ok) { console.log(`  ! ${q.slice(0, 40)}: ${res.error?.slice(0, 60)}`); continue; }
    const items = res.results.filter((r) => r.publishedDate).map((r, i) => `${i}. ${r.title ?? ''} :: ${(r.text ?? '').slice(0, 220)}`);
    if (!items.length) continue;
    // model pulls the company each item is ABOUT — the subject, not every name mentioned
    const llm = await chatComplete({
      model: 'deepseek-v4-flash', thinking: 'disabled', max_tokens: 900, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'For each numbered item, return the ONE company the item is primarily about, and a 6-word summary of what happened to them. Skip items that are not about a specific company doing something. Return {"items":[{"i":<number>,"company":"<name>","happened":"<6 words>"}]}' },
        { role: 'user', content: items.join('\n') },
      ],
    });
    let parsed: any = { items: [] };
    try { parsed = JSON.parse(llm.text); } catch { continue; }
    let inBook = 0;
    for (const it of parsed.items ?? []) {
      const hit = book.get(norm(String(it.company ?? '')));
      if (!hit) continue;
      inBook++;
      const r = res.results[it.i];
      if (!allHits.has(hit)) allHits.set(hit, { headline: String(it.happened), date: r?.publishedDate?.slice(0, 10) ?? '' });
    }
    console.log(`  "${q.slice(0, 46)}..."  ${res.results.length} results -> ${(parsed.items ?? []).length} companies -> ${inBook} IN YOUR BOOK`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${searches} market searches ($${(searches * 0.015).toFixed(2)}) lit up ${allHits.size} accounts in the book:\n`);
  for (const [name, h] of allHits) console.log(`  ${h.date}  ${name.padEnd(28)} ${h.headline}`);
  console.log(`\nACCOUNT-PROBE baseline, measured: 46 searches per account with a usable reason.`);
  console.log(`MARKET-SWEEP here            : ${allHits.size ? (searches / allHits.size).toFixed(2) : '-'} searches per account lit up.`);
})();
