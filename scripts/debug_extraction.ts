/**
 * Run one source's extraction pipeline WITHOUT writing signals. Prints the raw
 * items returned + what the LLM made of them + rejection reasons.
 *
 * Usage:
 *   pnpm dlx tsx scripts/debug_extraction.ts --source=<name-substring>
 *   pnpm dlx tsx scripts/debug_extraction.ts --type=web      # all web sources
 *   pnpm dlx tsx scripts/debug_extraction.ts --type=exa      # all exa sources
 *
 * For each source it dumps: query/url, raw item count, what the LLM extracted,
 * what got rejected and why. This is the input you tune the prompt against.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { parseRssOrAtom, enrichItemsWithCompanyName } from '../inngest/functions/sources/connectors/web.js';
import { batchExtractCompanies } from '../inngest/functions/sources/connectors/exa.js';

const EXTRACT_MODEL = 'gpt-4o-mini';

interface SourceRow {
  id: string;
  name: string;
  connector_type: string;
  config: Record<string, unknown>;
  workspace_id: string;
}

async function debugWeb(s: SourceRow) {
  const url = (s.config.url as string)?.trim();
  if (!url) { console.log(`  (no url)`); return; }
  const keywords = (s.config.keywords as string[] ?? []).filter(Boolean);
  const roles = (s.config.roles as string[] ?? []).filter(Boolean);
  const hint = (s.config.extraction_prompt as string) ?? '';

  console.log(`  url: ${url}`);
  console.log(`  keywords: ${JSON.stringify(keywords)}`);
  console.log(`  roles: ${JSON.stringify(roles)}`);

  const r = await fetch(url, { headers: { 'User-Agent': 'agent-crm/debug' } });
  if (!r.ok) { console.log(`  fetch failed: ${r.status}`); return; }
  const body = await r.text();

  const items = parseRssOrAtom(body, url);
  console.log(`  raw_items: ${items.length}`);
  for (const it of items.slice(0, 5)) {
    console.log(`    - ${(it.title ?? '').slice(0, 80)}`);
    console.log(`      ${(it.body ?? '').slice(0, 120)}`);
  }

  if (!items.length) return;

  const enriched = await enrichItemsWithCompanyName(items, { hint, roles, keywords }, EXTRACT_MODEL);
  const extracted = enriched.items.filter((it) => it.company_name);
  console.log(`  extracted_companies: ${extracted.length} / ${items.length}`);
  for (const it of extracted.slice(0, 10)) {
    console.log(`    OK  ${it.company_name?.padEnd(28)} from "${(it.title ?? '').slice(0, 60)}"`);
  }
  if (enriched.notes.size) {
    console.log(`  rejections (${enriched.notes.size}):`);
    const reasonCount = new Map<string, number>();
    for (const [, reason] of enriched.notes) reasonCount.set(reason, (reasonCount.get(reason) ?? 0) + 1);
    for (const [reason, count] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`    x${count}  ${reason}`);
    }
  }
}

async function debugExa(s: SourceRow) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) { console.log('  EXA_API_KEY missing'); return; }
  const query = (s.config.query as string)?.trim();
  if (!query) { console.log('  (no query)'); return; }
  const keywords = (s.config.keywords as string[] ?? []).filter(Boolean);
  const roles = (s.config.roles as string[] ?? []).filter(Boolean);
  const num_results = (s.config.num_results as number) ?? 25;
  const since_hours = (s.config.since_hours as number) ?? 168;

  console.log(`  query: ${query}`);
  console.log(`  keywords: ${JSON.stringify(keywords)}`);
  console.log(`  roles: ${JSON.stringify(roles)}`);

  const effectiveQuery = [query, ...(roles.length ? [`roles: ${roles.join(', ')}`] : []), ...(keywords.length ? [keywords.join(' ')] : [])].join(' ').slice(0, 500);
  const reqBody = {
    query: effectiveQuery,
    type: 'auto',
    numResults: Math.min(num_results, 100),
    contents: { text: { maxCharacters: 1500 } },
    startPublishedDate: new Date(Date.now() - since_hours * 3600 * 1000).toISOString(),
  };
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(reqBody),
  });
  if (!r.ok) { console.log(`  exa ${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
  const j = await r.json() as { results: Array<{ id: string; title: string | null; url: string; text?: string; author?: string }> };
  const results = j.results ?? [];
  console.log(`  raw_results: ${results.length}`);
  for (const er of results.slice(0, 5)) {
    console.log(`    - ${(er.title ?? '(no title)').slice(0, 80)}`);
    console.log(`      ${(er.text ?? '').slice(0, 120)}`);
  }
  if (!results.length) return;

  const companies = await batchExtractCompanies(results, { roles, keywords }, EXTRACT_MODEL);
  console.log(`  extracted_companies: ${companies.size} / ${results.length}`);
  for (const [, c] of [...companies].slice(0, 10)) {
    console.log(`    OK  ${c.name.padEnd(28)} (${c.domain ?? '-'})`);
  }
  const dropped = results.length - companies.size;
  if (dropped > 0) console.log(`  dropped: ${dropped}  (LLM omitted - keyword filter, no identifiable company, or filtered)`);
}

async function main() {
  const args = process.argv.slice(2);
  const typeArg = args.find((a) => a.startsWith('--type='))?.slice(7);
  const nameArg = args.find((a) => a.startsWith('--source='))?.slice(9);

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  let q = sb.from('sources').select('id, name, connector_type, config, workspace_id').eq('active', true);
  if (typeArg) q = q.eq('connector_type', typeArg);
  if (nameArg) q = q.ilike('name', `%${nameArg}%`);
  const r = await q;
  if (r.error) { console.error(r.error.message); process.exit(1); }
  const sources = (r.data ?? []) as SourceRow[];
  if (!sources.length) { console.log('no matching active sources'); return; }

  for (const s of sources) {
    console.log(`\n=== ${s.connector_type}/${s.name} ===`);
    try {
      if (s.connector_type === 'web') await debugWeb(s);
      else if (s.connector_type === 'exa') await debugExa(s);
      else console.log(`  (no debug handler for connector_type=${s.connector_type})`);
    } catch (e) {
      console.log(`  failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
