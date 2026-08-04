/**
 * Probe: does Exa actually honour includeText? The gate is rejecting ~55% of
 * everything on identity, and the rejected pages are plainly other companies
 * (UFC ratings for "Weyyak"), even though every non-own-site angle sends
 * includeText=[entity name]. Either the filter is not applied or the name is
 * present but incidental.
 *
 * Prints, per result, whether the entity name actually appears in the returned
 * title/text. Costs ~4 searches.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveEnvVar } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const EXA_API = 'https://api.exa.ai/search';

async function raw(apiKey: string, body: Record<string, unknown>) {
  const r = await fetch(EXA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false as const, status: r.status, error: (await r.text()).slice(0, 300) };
  return { ok: true as const, json: await r.json() as any };
}

async function probe(apiKey: string, label: string, body: Record<string, unknown>, name: string) {
  const res = await raw(apiKey, body);
  console.log(`\n--- ${label} ---`);
  console.log(`    req: ${JSON.stringify(body)}`);
  if (!res.ok) { console.log(`    HTTP ${res.status}: ${res.error}`); return; }
  const results = (res.json.results ?? []) as Array<{ title?: string; url: string; text?: string }>;
  console.log(`    ${results.length} results`);
  const needle = name.toLowerCase();
  for (const r of results) {
    const hay = `${r.title ?? ''} ${r.text ?? ''}`.toLowerCase();
    const hit = hay.includes(needle);
    console.log(`    [${hit ? 'NAME PRESENT' : 'NAME ABSENT '}] ${(r.title ?? '').slice(0, 70)} | ${r.url.slice(0, 80)}`);
  }
}

async function main() {
  const sb = createServerClient();
  const policy = await getPolicy(sb, WS);
  const apiKey = resolveEnvVar(policy, 'EXA_API_KEY');
  if (!apiKey) { console.log('no key'); return; }

  const name = process.argv[2] ?? 'Weyyak';
  const q = `${name} concurrent viewers OR peak viewers OR simultaneous streams`;
  const start = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  const contents = { text: { maxCharacters: 1500 } };

  // Exactly what the runner sends today.
  await probe(apiKey, 'as-shipped: type=auto, category=news, includeText', {
    query: q, type: 'auto', numResults: 3, category: 'news',
    startPublishedDate: start, includeText: [name], contents,
  }, name);

  // Same, but neural — includeText behaviour can differ by search type.
  await probe(apiKey, 'type=neural + includeText', {
    query: q, type: 'neural', numResults: 3, category: 'news',
    startPublishedDate: start, includeText: [name], contents,
  }, name);

  // Keyword search: the name is a literal token, not a weak embedding signal.
  await probe(apiKey, 'type=keyword + includeText', {
    query: q, type: 'keyword', numResults: 3, category: 'news',
    startPublishedDate: start, includeText: [name], contents,
  }, name);

  // Control: no includeText at all, to see what the filter is (or is not) doing.
  await probe(apiKey, 'control: no includeText', {
    query: q, type: 'auto', numResults: 3, category: 'news',
    startPublishedDate: start, contents,
  }, name);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
