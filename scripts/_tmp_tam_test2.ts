/** TAM TEST, done honestly: real named companies, production name gate.
 *
 * v1 extracted page titles as company names, so Exa returned industry news and
 * my weak check counted it as a hit. This uses companies I can name, and runs
 * `pageMentionsEntity` — the same gate production uses to throw away the 2,741
 * pages a fortnight that are about somebody else.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, resolveEnvVar, runExaSearch, pageMentionsEntity } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const VERTICALS = [
  {
    label: 'Midwest food & beverage manufacturers (press-poor, mid-size)',
    angle: '{entity} plant expansion OR new production line OR capacity OR new plant manager',
    companies: [
      { name: "Bongards' Creameries", domain: 'bongards.com' },
      { name: 'Schreiber Foods', domain: 'schreiberfoods.com' },
      { name: 'Sargento Foods', domain: 'sargento.com' },
      { name: 'Litehouse Foods', domain: 'litehousefoods.com' },
      { name: "Ken's Foods", domain: 'kensfoods.com' },
      { name: 'Kwik Trip', domain: 'kwiktrip.com' },
    ],
  },
  {
    label: 'regional trade contractors (press-poor, small)',
    angle: '{entity} expands OR new location OR hiring OR acquired OR new branch',
    companies: [
      { name: 'Roto-Rooter', domain: 'rotorooter.com' },
      { name: 'Mr. Rooter Plumbing', domain: 'mrrooter.com' },
      { name: 'Aire Serv', domain: 'aireserv.com' },
      { name: 'Benjamin Franklin Plumbing', domain: 'benjaminfranklinplumbing.com' },
      { name: 'One Hour Heating', domain: 'onehourheatandair.com' },
      { name: 'Bell Brothers', domain: 'bellbroshvac.com' },
    ],
  },
];

const FRESH_DAYS = 90;

(async () => {
  const policy: any = await getPolicy(sb, WS);
  const key = resolveEnvVar(policy, 'EXA_API_KEY')!;
  const since = new Date(Date.now() - FRESH_DAYS * 86400e3).toISOString().slice(0, 10);
  let spend = 0;

  for (const v of VERTICALS) {
    console.log(`\n${'='.repeat(78)}\n${v.label}\n${'='.repeat(78)}`);
    let named = 0, dated = 0;
    for (const c of v.companies) {
      const res = await runExaSearch(key, {
        query: v.angle.replace('{entity}', c.name),
        num_results: 8, type: 'auto', text_chars: 500, start_published_date: since,
      });
      spend++;
      if (!res.ok) { console.log(`  ${c.name.padEnd(28)} ! ${String(res.error).slice(0, 50)}`); continue; }
      // production gate: does the page actually name this company?
      const passing = res.results.filter((r) => pageMentionsEntity(c.name, c.domain, r, []));
      const withDate = passing.filter((r) => r.publishedDate);
      if (passing.length) named++;
      if (withDate.length) dated++;
      console.log(`  ${c.name.padEnd(28)} returned ${String(res.results.length).padStart(2)}  names them ${String(passing.length).padStart(2)}  AND dated ${String(withDate.length).padStart(2)}`);
      for (const r of withDate.slice(0, 2)) console.log(`      ${r.publishedDate!.slice(0, 10)}  ${(r.title ?? '').slice(0, 74)}`);
    }
    console.log(`\n  ${dated} of ${v.companies.length} companies had a DATED page that actually names them`);
  }
  console.log(`\ntotal spend: ${spend} searches, $${(spend * 0.015).toFixed(2)}`);
})();
