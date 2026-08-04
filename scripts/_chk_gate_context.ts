/**
 * Read-only: for the accounts research keeps rejecting, show exactly what the
 * relevance gate has to disambiguate with — the facts-derived context string and
 * whether it clears the 40-char `hasContext` bar that decides which unsure-rule
 * the prompt gets. No Exa spend, no LLM call.
 *
 * Usage: tsx scripts/_chk_gate_context.ts "Ab Films TV" "Simple Plus" ...
 *        tsx scripts/_chk_gate_context.ts --zero   (accounts with 0 signals last run)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

// Mirrors entityContext() in inngest/functions/research.ts (facts half only —
// own-site snippets are runtime and cost an Exa call).
const DESC_RE = /desc|industr|sector|product|offer|what|target|customer|vertical|categor|summary|tagline|business|market|does/;

async function main() {
  const sb = createServerClient();
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const zeroMode = process.argv.includes('--zero');

  let targets: Array<{ id: string; name: string }> = [];
  if (zeroMode) {
    const since = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const { data } = await sb.from('events').select('target_id, payload')
      .eq('workspace_id', WS).eq('action', 'research_completed')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(200);
    const zero = [...new Set((data ?? [])
      .filter((r: any) => (r.payload?.results_created ?? 0) === 0 && (r.payload?.filtered_by?.identity ?? 0) > 0)
      .map((r: any) => r.target_id))].slice(0, 15);
    const { data: es } = await sb.from('entities').select('id, name').in('id', zero as string[]);
    targets = (es ?? []) as any;
  } else {
    for (const n of args) {
      const { data } = await sb.from('entities').select('id, name')
        .eq('workspace_id', WS).eq('name', n).maybeSingle();
      if (data) targets.push(data as any);
    }
  }
  if (!targets.length) { console.log('no targets'); return; }

  for (const t of targets) {
    const { data: fdata } = await sb.from('facts')
      .select('predicate, object_text')
      .eq('workspace_id', WS).eq('subject_entity', t.id).is('supersedes', null).limit(40);
    const facts = (fdata ?? []) as Array<{ predicate: string; object_text: string | null }>;
    const desc: string[] = [];
    for (const f of facts) {
      if (/^score_/.test(f.predicate) || /_breakdown$/.test(f.predicate)) continue;
      if (!DESC_RE.test(f.predicate)) continue;
      const v = f.object_text?.trim();
      if (!v || v.length < 3) continue;
      desc.push(`${f.predicate}: ${v}`);
      if (desc.length >= 6) break;
    }
    const ctx = desc.join('; ').slice(0, 600);
    const { data: ent } = await sb.from('entities').select('attributes').eq('id', t.id).maybeSingle();
    const domain = (ent as any)?.attributes?.domain ?? '(none)';
    const nonScoreFacts = facts.filter((f) => !/^score_/.test(f.predicate) && !/_breakdown$/.test(f.predicate));

    console.log(`\n=== ${t.name}  [${domain}] ===`);
    console.log(`facts total ${facts.length}, non-score ${nonScoreFacts.length}, matched-descriptive ${desc.length}`);
    console.log(`context len ${ctx.length}  ->  hasContext=${ctx.trim().length >= 40}  ${ctx.trim().length >= 40 ? '(lenient unsure-rule)' : '(HARSH unsure-rule: reject unless page cites the domain)'}`);
    console.log(`context: ${ctx || '(EMPTY)'}`);
    if (!desc.length && nonScoreFacts.length) {
      console.log(`predicates present but NOT matched by the descriptive regex:`);
      console.log(`  ${[...new Set(nonScoreFacts.map((f) => f.predicate))].join(', ')}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
