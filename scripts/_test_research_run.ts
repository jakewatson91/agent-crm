import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveStrategy, runExaSearch, entityIdsOfType } from '@agent-crm/tools';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

type Angle = ReturnType<typeof resolveStrategy>[number];

function build(angle: Angle, name: string, domain: string) {
  const query = angle.query_template.replaceAll('{entity}', name).replaceAll('{domain}', domain).replace(/\s+/g, ' ').trim().slice(0, 300);
  const start = angle.recency_days ? new Date(Date.now() - angle.recency_days * 86400000).toISOString() : undefined;
  const num = angle.num_results ?? 4;
  if (angle.domain_scope === 'own_site') {
    if (!domain) return null;
    return { query, params: { query, num_results: num, include_domains: [domain] } };
  }
  if (angle.domain_scope === 'news') return { query, params: { query, num_results: num, category: 'news' as const, start_published_date: start, include_text: [name] } };
  return { query, params: { query, num_results: num, start_published_date: start, include_text: [name] } };
}

async function main() {
  const supabase = createServerClient();
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) { console.log('NO EXA_API_KEY'); return; }
  const policy = await getPolicy(supabase, WS);
  const angles = resolveStrategy(policy);
  console.log('strategy angles:', angles.map((a) => a.id).join(', '), '\n');

  const acctIds = await entityIdsOfType(supabase, WS, 'account');
  const ents = await supabase.from('entities').select('id, name, attributes').in('id', acctIds.slice(0, 300));
  const withDomain = ((ents.data ?? []) as Array<{ id: string; name: string; attributes: { domain?: string } | null }>)
    .filter((e) => { const d = e.attributes?.domain ?? ''; return d && !d.endsWith('.example'); });
  const entity = withDomain[0];
  if (!entity) { console.log('no account with a real domain found'); return; }
  const domain = (entity.attributes?.domain ?? '').toLowerCase();
  console.log(`ENTITY: ${entity.name}  (domain: ${domain})\n${'='.repeat(60)}`);

  for (const a of angles) {
    const built = build(a, entity.name, domain);
    if (!built) { console.log(`\n[${a.id}] SKIPPED (no domain)`); continue; }
    const res = await runExaSearch(apiKey, built.params);
    console.log(`\n[${a.id}] (${a.domain_scope}) q="${built.query}"`);
    if (!res.ok) { console.log(`   ERROR ${res.status ?? ''} ${res.error}`); continue; }
    if (!res.results.length) { console.log('   (no results)'); continue; }
    for (const r of res.results) {
      console.log(`   - ${(r.title ?? '(no title)').slice(0, 80)}`);
      console.log(`     ${r.url}  ${r.publishedDate ?? ''}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
