import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

(async () => {
  // current score_total per account (the not-superseded row)
  const { data: srows } = await db.from('facts')
    .select('id, subject_entity, object_text, supersedes')
    .eq('workspace_id', ws).eq('predicate', 'score_total');
  const pointed = new Set((srows ?? []).map((r: any) => r.supersedes).filter(Boolean));
  const score = new Map<string, number>();
  for (const r of (srows ?? []) as any[]) { if (pointed.has(r.id)) continue; const v = parseFloat(r.object_text ?? ''); if (Number.isFinite(v)) score.set(r.subject_entity, v); }

  // accounts that HAVE a linked contact (works_at object_entity)
  const { data: links } = await db.from('facts')
    .select('object_entity').eq('workspace_id', ws).eq('predicate', 'works_at').is('supersedes', null);
  const hasContact = new Set((links ?? []).map((r: any) => r.object_entity).filter(Boolean));

  // strong accounts (>=0.6) with no contact, with a domain
  const candidates: Array<{ id: string; name: string; score: number; domain: string }> = [];
  const strong = [...score.entries()].filter(([id, s]) => s >= 0.6 && !hasContact.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [id, s] of strong) {
    const { data: ent } = await db.from('entities').select('name, attributes').eq('id', id).maybeSingle();
    const attrs = (ent?.attributes ?? {}) as any;
    if (attrs._candidate) continue;
    const domain = (attrs.domain ?? '').trim();
    if (!domain) continue;
    candidates.push({ id, name: ent?.name ?? '?', score: s, domain });
  }

  console.log(`strong (>=0.6) accounts with NO contact and a domain: ${candidates.length}`);
  for (const c of candidates.slice(0, 15)) console.log(`  ${c.score.toFixed(2)}  ${c.domain.padEnd(28)} ${c.id}  "${c.name}"`);
})();
