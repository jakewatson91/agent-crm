import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  async function paged(pred: string, sel = 'subject_entity, object_entity, object_text') {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const rows = ((await sb.from('facts').select(sel).eq('workspace_id', ws).eq('predicate', pred).is('supersedes', null).range(from, from + 999)).data ?? []) as any[];
      out.push(...rows); if (rows.length < 1000) break;
    } return out;
  }
  const acct = new Set((await paged('is_a')).filter((f) => f.object_text === 'account').map((f) => f.subject_entity));
  const withContact = new Set((await paged('works_at')).filter((f) => f.object_entity && acct.has(f.object_entity)).map((f) => f.object_entity));
  const scores = new Map<string, number>();
  for (const f of await paged('score_total')) if (acct.has(f.subject_entity)) scores.set(f.subject_entity, parseFloat(f.object_text));
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const rows = ents.filter((e) => acct.has(e.id) && !withContact.has(e.id) && e.attributes?.domain && !String(e.attributes.domain).endsWith('.example'))
    .map((e) => ({ id: e.id, name: e.name, domain: String(e.attributes.domain).toLowerCase(), score: scores.get(e.id) ?? null }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  console.log(`scored accounts total: ${scores.size} | contactless w/ domain: ${rows.length}`);
  console.log('=== TOP 20 contactless by score_total ===');
  rows.slice(0, 20).forEach((r, i) => console.log(`${String(i+1).padStart(2)}. ${r.score?.toFixed(3) ?? ' none'}  ${r.name.padEnd(22).slice(0,22)} ${r.domain}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
