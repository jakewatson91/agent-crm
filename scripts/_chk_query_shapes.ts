/**
 * Compare query shapes on the same account. The shipped templates are OR-heavy
 * keyword lists ("{entity} concurrent viewers OR peak viewers OR simultaneous
 * streams"); in an embedding search the topic words dominate and an unknown
 * brand name contributes almost nothing, so Exa returns the best article about
 * the TOPIC rather than about the company.
 *
 * Scores each shape by the only thing that matters upstream of the gate: what
 * fraction of returned pages actually mention the company.
 *
 * Costs ~1 search per shape per account.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveEnvVar } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const EXA_API = 'https://api.exa.ai/search';

const SHAPES: Array<{ id: string; q: (n: string) => string; type: string; includeText: boolean }> = [
  { id: 'shipped (OR list, auto)', q: (n) => `${n} concurrent viewers OR peak viewers OR simultaneous streams`, type: 'auto', includeText: true },
  { id: 'name-first, no OR, auto', q: (n) => `${n} peak concurrent viewers`, type: 'auto', includeText: true },
  { id: 'natural language, auto', q: (n) => `How many concurrent viewers does ${n} get?`, type: 'auto', includeText: true },
  { id: 'company-anchored, auto', q: (n) => `${n} streaming service audience size and viewership`, type: 'auto', includeText: true },
  { id: 'name only, auto', q: (n) => `${n}`, type: 'auto', includeText: true },
  { id: 'shipped OR list, keyword', q: (n) => `${n} concurrent viewers OR peak viewers OR simultaneous streams`, type: 'keyword', includeText: true },
];

async function run(apiKey: string, body: Record<string, unknown>) {
  const r = await fetch(EXA_API, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  return (await r.json()) as any;
}

async function main() {
  const sb = createServerClient();
  const policy = await getPolicy(sb, WS);
  const apiKey = resolveEnvVar(policy, 'EXA_API_KEY');
  if (!apiKey) return;
  const names = process.argv.slice(2);
  const start = new Date(Date.now() - 90 * 86400 * 1000).toISOString();

  for (const name of names) {
    console.log(`\n################ ${name} ################`);
    for (const s of SHAPES) {
      const body: Record<string, unknown> = {
        query: s.q(name), type: s.type, numResults: 5, category: 'news',
        startPublishedDate: start, contents: { text: { maxCharacters: 800 } },
      };
      if (s.includeText) body.includeText = [name];
      const j = await run(apiKey, body);
      const results = (j?.results ?? []) as Array<{ title?: string; url: string; text?: string }>;
      const needle = name.toLowerCase();
      const onTopic = results.filter((r) => `${r.title ?? ''} ${r.text ?? ''}`.toLowerCase().includes(needle));
      console.log(`\n  ${s.id.padEnd(28)} -> ${onTopic.length}/${results.length} mention the company`);
      console.log(`  q: ${s.q(name)}`);
      for (const r of results) {
        const hit = `${r.title ?? ''} ${r.text ?? ''}`.toLowerCase().includes(needle);
        console.log(`      ${hit ? '+' : '-'} ${(r.title ?? '').slice(0, 78)}`);
      }
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
