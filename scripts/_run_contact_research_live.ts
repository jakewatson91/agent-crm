import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3'; // Sudden
const N = Number(process.argv[2] ?? 3);

async function main() {
  const supabase = createServerClient();
  const contactIds = await entityIdsOfType(supabase, WS, 'contact');

  const worksAt = await supabase.from('facts').select('subject_entity, object_entity')
    .eq('workspace_id', WS).eq('predicate', 'works_at').is('supersedes', null)
    .in('subject_entity', contactIds.slice(0, 500));
  const accountByContact = new Map<string, string>();
  for (const r of (worksAt.data ?? []) as Array<{ subject_entity: string; object_entity: string | null }>) {
    if (r.object_entity) accountByContact.set(r.subject_entity, r.object_entity);
  }
  const linkedIds = [...accountByContact.keys()];

  const scoreRows = await supabase.from('facts').select('subject_entity, object_text, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'score_total').is('supersedes', null)
    .in('subject_entity', [...new Set(accountByContact.values())]);
  const scoreByAccount = new Map<string, number>();
  for (const r of (scoreRows.data ?? []) as Array<{ subject_entity: string; object_text: string | null }>) {
    const v = parseFloat(r.object_text ?? '');
    if (Number.isFinite(v)) scoreByAccount.set(r.subject_entity, v);
  }

  const ents = await supabase.from('entities').select('id, name').in('id', linkedIds);
  const nameById = new Map(((ents.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
  const roleRows = await supabase.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS).eq('predicate', 'role').is('supersedes', null).in('subject_entity', linkedIds);
  const roleById = new Map(((roleRows.data ?? []) as Array<{ subject_entity: string; object_text: string | null }>).map((r) => [r.subject_entity, r.object_text ?? '']));

  const targets = linkedIds
    .map((id) => ({ id, name: nameById.get(id) ?? '(unknown)', role: roleById.get(id) ?? '', account_score: scoreByAccount.get(accountByContact.get(id)!) ?? 0 }))
    .filter((c) => c.account_score >= 0.6)
    .sort((a, b) => b.account_score - a.account_score)
    .slice(0, N);

  console.log(`Running REAL contact-kind research (writes signals) on ${targets.length} contacts...\n`);
  for (const t of targets) {
    console.log(`• ${t.name}${t.role ? ` (${t.role})` : ''} — account score ${t.account_score.toFixed(2)}`);
    const r = await runEntityResearch(supabase, {
      workspace_id: WS, entity_id: t.id, entity_name: t.name,
      reason: 'manual-contact-proof', kind: 'contact',
    });
    console.log(`    ${JSON.stringify(r)}`);
  }

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sig = await supabase.from('signals')
    .select('entity_id, structured_tags, observed_at, body_for_embedding')
    .eq('workspace_id', WS).eq('type', 'research_result')
    .gte('observed_at', since)
    .order('observed_at', { ascending: false });
  const rows = ((sig.data ?? []) as Array<{ structured_tags: any; body_for_embedding: string | null }>)
    .filter((r) => r.structured_tags?.triggered_by === 'manual-contact-proof');

  console.log(`\n=== ${rows.length} new research_result signals in last 10 min ===`);
  for (const s of rows.slice(0, 30)) {
    const t = s.structured_tags ?? {};
    console.log(`- [${t.research_kind}/${t.research_angle}] ${(s.body_for_embedding || '').split('\n')[0].slice(0, 100)}`);
    console.log(`    ${t.url}  ${t.published_at ?? ''}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
