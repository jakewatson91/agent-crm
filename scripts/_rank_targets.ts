import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  async function pagedFacts(pred: string, obj?: string) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from('facts').select('subject_entity, object_entity, object_text').eq('workspace_id', ws).eq('predicate', pred).range(from, from + 999);
      if (obj) q = q.eq('object_text', obj);
      const r = await q; const rows = (r.data ?? []) as any[]; out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }
  const acctIds = new Set((await pagedFacts('is_a', 'account')).map((f) => f.subject_entity));
  const worksAt = await pagedFacts('works_at');
  const acctsWithContact = new Set<string>();
  for (const f of worksAt) if (f.object_entity && acctIds.has(f.object_entity)) acctsWithContact.add(f.object_entity);

  // hiring signals -> entity set
  const sigs = (await sb.from('signals').select('entity_id, type').eq('workspace_id', ws).limit(5000)).data ?? [];
  const hiringEntities = new Set<string>();
  for (const s of sigs as any[]) if (s.type === 'hiring_post' && s.entity_id) hiringEntities.add(s.entity_id);

  // load all account entities
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999);
    const rows = (r.data ?? []) as any[]; ents.push(...rows);
    if (rows.length < 1000) break;
  }
  const accts = ents.filter((e) => acctIds.has(e.id) && !acctsWithContact.has(e.id));

  const targets = accts.map((e) => {
    const a = e.attributes ?? {};
    const domain: string = a.domain ?? '';
    const realDomain = domain && !domain.endsWith('.example') && domain.includes('.');
    const tags: string[] = Array.isArray(a.tags) ? a.tags : [];
    const tagStr = tags.join(' ').toLowerCase();
    let score = 0; const why: string[] = [];
    if (hiringEntities.has(e.id)) { score += 4; why.push('HIRING-signal'); }
    if (a.ats?.provider && a.ats.provider !== 'none') { score += 2; why.push(`ats:${a.ats.provider}`); }
    if (a.is_hiring === true) { score += 1; why.push('is_hiring'); }
    if (a.yc_slug) { score += 2; why.push('YC'); }
    if (typeof a.yc_batch === 'string' && /2025|2026/.test(a.yc_batch)) { score += 1; why.push(a.yc_batch); }
    if (/sales|gtm|crm|outbound|revenue/.test(tagStr)) { score += 2; why.push('sales-tag'); }
    if (/\bai\b|artificial intelligence|agent/.test(tagStr)) { score += 1; why.push('AI-tag'); }
    if (a.industry === 'B2B') { score += 1; why.push('B2B'); }
    return { name: e.name, domain, realDomain, score, why, batch: a.yc_batch ?? '', one: (a.one_liner ?? '').slice(0, 60) };
  }).filter((t) => t.realDomain)
    .sort((x, y) => y.score - x.score);

  console.log(`contactless accounts w/ real domain: ${targets.length}`);
  console.log(`score distribution:`, Object.entries(targets.reduce((m: any, t) => { m[t.score] = (m[t.score]||0)+1; return m; }, {})).sort((a,b)=>Number(b[0])-Number(a[0])).map(([s,n])=>`${s}:${n}`).join(' '));
  console.log(`\n=== TOP 50 TARGETS ===`);
  targets.slice(0, 50).forEach((t, i) => {
    console.log(`${String(i+1).padStart(2)}. [${t.score}] ${t.name.padEnd(22).slice(0,22)} ${t.domain.padEnd(26)} ${t.why.join(',')}`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
