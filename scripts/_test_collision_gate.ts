import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveStrategy, runExaSearch, filterResultsByEntity, fetchEntityGrounding, entityIdsOfType } from '@agent-crm/tools';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const NAMES = process.argv.slice(2);

type Angle = ReturnType<typeof resolveStrategy>[number];

function build(angle: Angle, name: string, domain: string) {
  const query = angle.query_template.replaceAll('{entity}', name).replaceAll('{domain}', domain).replace(/\s+/g, ' ').trim().slice(0, 300);
  const start = angle.recency_days ? new Date(Date.now() - angle.recency_days * 86400000).toISOString() : undefined;
  const num = angle.num_results ?? 4;
  if (angle.domain_scope === 'news') return { query, params: { query, num_results: num, category: 'news' as const, start_published_date: start, include_text: [name] } };
  return { query, params: { query, num_results: num, start_published_date: start, include_text: [name] } };
}

async function main() {
  const supabase = createServerClient();
  const apiKey = process.env.EXA_API_KEY!;
  const policy = await getPolicy(supabase, WS);
  const angles = resolveStrategy(policy).filter((a) => a.domain_scope !== 'own_site');

  const acctIds = await entityIdsOfType(supabase, WS, 'account');
  const ents = await supabase.from('entities').select('id, name, attributes').in('id', acctIds.slice(0, 150));
  const all = (ents.data ?? []) as Array<{ id: string; name: string; attributes: { domain?: string } | null }>;
  const targets = NAMES.length ? all.filter((e) => NAMES.includes(e.name)) : all.filter((e) => { const d = e.attributes?.domain ?? ''; return d && !d.endsWith('.example'); }).slice(0, 3);

  for (const t of targets) {
    const domain = (t.attributes?.domain ?? '').toLowerCase();
    console.log(`\n#### ${t.name}  (${domain}) ####`);
    const results: Array<{ id: string; title: string | null; url: string; text?: string }> = [];
    for (const a of angles) {
      const b = build(a, t.name, domain);
      const r = await runExaSearch(apiKey, b.params);
      if (r.ok) for (const er of r.results) results.push(er);
    }
    const facts = await supabase.from('facts').select('predicate, object_text').eq('workspace_id', WS).eq('subject_entity', t.id).is('supersedes', null).limit(40);
    const desc: string[] = [];
    for (const f of (facts.data ?? []) as Array<{ predicate: string; object_text: string | null }>) {
      if (/^score_|_breakdown$/.test(f.predicate)) continue;
      if (!/desc|industr|sector|product|offer|what|target|customer|vertical|categor|summary|tagline|business|market|does/.test(f.predicate)) continue;
      if (f.object_text) desc.push(`${f.predicate}: ${f.object_text}`);
      if (desc.length >= 6) break;
    }
    const grounding = await fetchEntityGrounding(process.env.EXA_API_KEY!, t.name, domain);
    const context = [grounding, desc.join('; ')].filter(Boolean).join(' || ').slice(0, 600);
    console.log('context:', context || '(none — name + domain only)');
    const rel = await filterResultsByEntity({ name: t.name, domain, context }, results);
    console.log(`\nKEPT (${rel.accepted.size}/${results.length}, auto-by-domain=${rel.auto}):`);
    for (const er of results) if (rel.accepted.has(er.id)) console.log('  ✓', (er.title ?? '').slice(0, 72), '|', er.url);
    console.log('DROPPED (same-name / unrelated):');
    for (const er of results) if (!rel.accepted.has(er.id)) console.log('  ✗', (er.title ?? '').slice(0, 72), '|', er.url);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
