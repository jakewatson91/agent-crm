/**
 * Read-only: why does Intigral gate on dates? Dump its facts alongside the
 * signal each came from, showing what date (if any) the signal carries and
 * where that date came from.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const NAME = process.argv[2] ?? 'Intigral';

async function main() {
  const { data: ents } = await sb.from('entities').select('id, name').eq('workspace_id', WS).ilike('name', `%${NAME}%`).limit(1);
  const ent = (ents ?? [])[0] as { id: string; name: string } | undefined;
  if (!ent) throw new Error(`no entity matching ${NAME}`);
  console.log(`=== ${ent.name} ===\n`);

  const { data: allFacts } = await sb.from('facts')
    .select('id, predicate, object_text, observed_at, signal_id, supersedes')
    .eq('workspace_id', WS).eq('subject_entity', ent.id);
  const rows = (allFacts ?? []) as any[];
  const pointed = new Set(rows.map((f) => f.supersedes).filter(Boolean));
  const active = rows.filter((f) => !pointed.has(f.id) && !f.predicate.startsWith('score_') &&
    !['icp_fit', 'icp_fit_breakdown', 'contact_score', 'dropped_until', 'outreach_cooldown_until'].includes(f.predicate));

  const sigIds = [...new Set(active.map((f) => f.signal_id).filter(Boolean))] as string[];
  const sigs = new Map<string, any>();
  if (sigIds.length) {
    const { data } = await sb.from('signals').select('id, type, observed_at, structured_tags, body_for_embedding').in('id', sigIds);
    for (const s of (data ?? []) as any[]) sigs.set(s.id, s);
  }

  let dated = 0, undated = 0, nosignal = 0;
  for (const f of active.sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))) {
    const s = f.signal_id ? sigs.get(f.signal_id) : null;
    const pub = s?.structured_tags?.published_at;
    const unreadable = s?.structured_tags?.published_at_unreadable;
    const src = s?.structured_tags?.published_at_source;
    if (!f.signal_id) nosignal++; else if (pub) dated++; else undated++;
    const tag = !f.signal_id ? 'NO SIGNAL' : pub ? `published ${String(pub).slice(0, 10)}${src ? ` (${src})` : ''}` : `UNDATED${unreadable ? ` [unreadable: ${unreadable}]` : ''}`;
    console.log(`${tag.padEnd(38)} ${f.predicate} :: ${String(f.object_text).slice(0, 95)}`);
  }
  console.log(`\n${active.length} active facts: ${dated} dated, ${undated} undated-with-signal, ${nosignal} with no signal at all`);

  console.log('\n=== signals behind them ===');
  for (const [, s] of sigs) {
    const t = s.structured_tags ?? {};
    console.log(`\n${s.id.slice(0, 8)} type=${s.type} observed=${String(s.observed_at).slice(0, 10)}`);
    console.log(`  tags: ${JSON.stringify(t).slice(0, 400)}`);
    console.log(`  body: ${String(s.body_for_embedding ?? '').slice(0, 260).replace(/\n/g, ' ')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
