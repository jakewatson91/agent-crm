import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  async function paged(pred: string, sel = 'subject_entity, object_entity, object_text, supersedes') {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) { const rows = ((await sb.from('facts').select(sel).eq('workspace_id', ws).eq('predicate', pred).is('supersedes', null).range(from, from + 999)).data ?? []) as any[]; out.push(...rows); if (rows.length < 1000) break; } return out;
  }
  const isa = await paged('is_a');
  const contactIds = new Set(isa.filter((f) => f.object_text === 'contact').map((f) => f.subject_entity));
  const acctIds = new Set(isa.filter((f) => f.object_text === 'account').map((f) => f.subject_entity));
  const cs = new Map<string, number>(); for (const f of await paged('contact_score')) cs.set(f.subject_entity, parseFloat(f.object_text));
  const roles = new Map<string, string>(); for (const f of await paged('role')) if (!roles.has(f.subject_entity)) roles.set(f.subject_entity, f.object_text);
  const worksAt = new Map<string, string>(); for (const f of await paged('works_at')) worksAt.set(f.subject_entity, f.object_entity);
  // POLLUTION CHECK: any contact carrying icp_fit or score_total?
  const icpOnContacts = (await paged('icp_fit')).filter((f) => contactIds.has(f.subject_entity)).length;
  const stOnContacts = (await paged('score_total')).filter((f) => contactIds.has(f.subject_entity)).length;
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const name = new Map(ents.map((e) => [e.id, e.name]));

  const rows = [...cs.entries()].map(([id, score]) => ({ score, name: name.get(id) ?? id, role: roles.get(id) ?? '', acct: name.get(worksAt.get(id) ?? '') ?? '?' })).sort((a, b) => b.score - a.score);
  console.log(`=== POLLUTION CHECK ===`);
  console.log(`contacts carrying icp_fit:    ${icpOnContacts}  (must be 0)`);
  console.log(`contacts carrying score_total: ${stOnContacts}  (must be 0)`);
  console.log(`contacts scored: ${cs.size}\n`);
  console.log('=== TOP 12 contacts by contact_score ===');
  rows.slice(0, 12).forEach((r) => console.log(`  ${r.score.toFixed(2)}  ${String(r.name).padEnd(22).slice(0,22)} ${String(r.role).padEnd(34).slice(0,34)} @ ${r.acct}`));
  console.log('\n=== BOTTOM 6 ===');
  rows.slice(-6).forEach((r) => console.log(`  ${r.score.toFixed(2)}  ${String(r.name).padEnd(22).slice(0,22)} ${String(r.role).padEnd(34).slice(0,34)} @ ${r.acct}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
