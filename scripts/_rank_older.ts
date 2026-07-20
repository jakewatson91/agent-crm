import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  async function pagedFacts(pred: string, obj?: string) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from('facts').select('subject_entity, object_entity').eq('workspace_id', ws).eq('predicate', pred).range(from, from + 999);
      if (obj) q = q.eq('object_text', obj);
      const rows = ((await q).data ?? []) as any[]; out.push(...rows); if (rows.length < 1000) break;
    } return out;
  }
  const acctIds = new Set((await pagedFacts('is_a', 'account')).map((f) => f.subject_entity));
  const withContact = new Set((await pagedFacts('works_at')).filter((f) => f.object_entity && acctIds.has(f.object_entity)).map((f) => f.object_entity));
  const sigs = (await sb.from('signals').select('entity_id, type').eq('workspace_id', ws).limit(5000)).data ?? [];
  const hiring = new Set((sigs as any[]).filter((s) => s.type === 'hiring_post' && s.entity_id).map((s) => s.entity_id));
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }

  const COMPETITOR = /lead|throxy|persana|bizzy|agentmail|sameday|outreach|prospect|sdr|sales\s?ai|clay|apollo/i;
  const targets = ents.filter((e) => acctIds.has(e.id) && !withContact.has(e.id)).map((e) => {
    const a = e.attributes ?? {}; const yr = String(a.yc_batch ?? '').match(/20\d\d/)?.[0];
    const domain = String(a.domain ?? ''); const tags = (Array.isArray(a.tags) ? a.tags : []).join(' ').toLowerCase();
    let score = 0; const why: string[] = [];
    if (hiring.has(e.id)) { score += 4; why.push('HIRING'); }
    if (a.ats?.provider && a.ats.provider !== 'none') { score += 1; why.push('ats'); }
    if (a.is_hiring === true) { score += 1; why.push('hiring'); }
    if (/sales|gtm|crm|revenue/.test(tags)) { score += 2; why.push('sales'); }
    if (/\bai\b|agent/.test(tags)) { score += 1; }
    return { name: e.name, domain, yr, score, why, real: domain && !domain.endsWith('.example') && domain.includes('.'), comp: COMPETITOR.test(e.name + ' ' + tags) };
  }).filter((t) => t.real && (t.yr === '2023' || t.yr === '2024') && !t.comp).sort((x, y) => y.score - x.score);

  console.log(`2023-24 contactless non-competitor targets: ${targets.length}`);
  console.log('=== TOP 12 (next batch candidates) ===');
  targets.slice(0, 12).forEach((t, i) => console.log(`${String(i+1).padStart(2)}. [${t.score}] ${t.name.padEnd(22).slice(0,22)} ${t.domain.padEnd(26)} ${t.yr} ${t.why.join(',')}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
