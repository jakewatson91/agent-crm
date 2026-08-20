/** Can a plain-English market definition become a clean list of REAL companies?
 *
 * Discovery was frozen on purpose (junk entities, query craft not self-serve).
 * But "watch your whole market" is impossible if the customer must bring the
 * list. This tests whether the frozen decision still holds, using a domain-first
 * rule rather than titles: a real company has its own domain, and the page that
 * ranks for its name IS that domain.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, resolveEnvVar, runExaSearch } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const AGGREGATORS = /linkedin|facebook|instagram|twitter|x\.com|youtube|yelp|indeed|glassdoor|crunchbase|zoominfo|bloomberg|wikipedia|reddit|tripadvisor|bbb\.org|manta|dnb\.com|apollo\.io|angi|thumbtack|houzz|mapquest|yellowpages/i;

const MARKETS = [
  { label: 'independent dental practices in Ohio', q: 'independent family dental practice Ohio official website book appointment' },
  { label: 'craft breweries in Colorado', q: 'craft brewery Colorado taproom official website' },
  { label: 'commercial HVAC contractors in Texas', q: 'commercial HVAC contractor Texas official website services' },
];

(async () => {
  const policy: any = await getPolicy(sb, WS);
  const key = resolveEnvVar(policy, 'EXA_API_KEY')!;
  let spend = 0;
  for (const m of MARKETS) {
    console.log(`\n${'='.repeat(76)}\n${m.label}\n${'='.repeat(76)}`);
    const res = await runExaSearch(key, { query: m.q, num_results: 25, type: 'auto', text_chars: 200 });
    spend++;
    if (!res.ok) { console.log('  failed:', res.error); continue; }
    const seen = new Set<string>(); const keep: Array<{ host: string; title: string }> = [];
    let junk = 0;
    for (const r of res.results) {
      let host = '';
      try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { junk++; continue; }
      if (AGGREGATORS.test(host)) { junk++; continue; }        // directory / social, not a company
      if (seen.has(host)) continue;
      seen.add(host);
      keep.push({ host, title: (r.title ?? '').slice(0, 58) });
    }
    console.log(`  ${res.results.length} results -> ${keep.length} distinct company domains, ${junk} directory/social dropped\n`);
    for (const k of keep.slice(0, 14)) console.log(`    ${k.host.padEnd(36)} ${k.title}`);
  }
  console.log(`\ntotal: ${spend} searches, $${(spend * 0.015).toFixed(2)}`);
})();
