import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  async function paged(pred: string) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) { const rows = ((await sb.from('facts').select('subject_entity, object_entity, object_text').eq('workspace_id', ws).eq('predicate', pred).is('supersedes', null).range(from, from + 999)).data ?? []) as any[]; out.push(...rows); if (rows.length < 1000) break; } return out;
  }
  const acct = new Set((await paged('is_a')).filter((f) => f.object_text === 'account').map((f) => f.subject_entity));
  const withContact = new Set((await paged('works_at')).filter((f) => f.object_entity && acct.has(f.object_entity)).map((f) => f.object_entity));
  const scores = new Map<string, number>();
  for (const f of await paged('score_total')) if (acct.has(f.subject_entity)) scores.set(f.subject_entity, parseFloat(f.object_text));
  const sigs = (await sb.from('signals').select('entity_id, type').eq('workspace_id', ws).limit(5000)).data ?? [];
  const hiring = new Set((sigs as any[]).filter((s) => s.type === 'hiring_post' && s.entity_id).map((s) => s.entity_id));
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  function fit(e: any): number {
    const a = e.attributes ?? {}; const tags = (Array.isArray(a.tags) ? a.tags : []).join(' ').toLowerCase();
    let s = 0;
    if (hiring.has(e.id)) s += 4;
    if (a.ats?.provider && a.ats.provider !== 'none') s += 1;
    if (a.is_hiring === true) s += 1;
    if (/\bai\b|agent/.test(tags)) s += 1;
    if (a.industry === 'B2B') s += 1;
    if (/2025|2024/.test(String(a.yc_batch ?? ''))) s += 1;
    return s;
  }
  const cand = ents.filter((e) => acct.has(e.id) && !withContact.has(e.id) && e.attributes?.domain && !String(e.attributes.domain).endsWith('.example') && e.attributes?.yc_slug)
    .map((e) => ({ name: e.name, domain: String(e.attributes.domain).toLowerCase(), score: scores.get(e.id) ?? -1, fit: fit(e) }))
    .sort((a, b) => (b.score - a.score) || (b.fit - a.fit) || a.name.localeCompare(b.name))
    .slice(0, 60);
  writeFileSync('scripts/_candidates.json', JSON.stringify(cand.map((c) => ({ name: c.name, domain: c.domain })), null, 0));
  console.log(`wrote ${cand.length} candidates`);
  console.log(cand.map((c) => c.domain).join(' '));
}
main().catch((e) => { console.error(e); process.exit(1); });
