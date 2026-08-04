/**
 * Read-only audit of research signals already stored: how many never name the
 * company they are attached to?
 *
 * Ab Films TV showed the problem — 4 of its 6 research_result signals are other
 * companies (ablfilms.com, abfilms.ca, shots.com) that got in before the
 * collision gate tightened. The enricher has already turned those pages into
 * facts on the entity, so this is not just wasted spend, it is wrong data the
 * scorer and drafter are reading.
 *
 * Uses the same check the runner now applies at fetch time, so the number here
 * is exactly what would have been blocked had it existed then.
 *
 * Usage: tsx scripts/_chk_signal_corpus_quality.ts [--list]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { fetchAll, pageMentionsEntity } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const LIST = process.argv.includes('--list');

async function main() {
  const sb = createServerClient();
  const sigs = await fetchAll<{ entity_id: string; observed_at: string; body_for_embedding: string | null; structured_tags: any }>(
    (from, to) => sb.from('signals')
      .select('entity_id, observed_at, body_for_embedding, structured_tags')
      .eq('workspace_id', WS).eq('type', 'research_result').order('observed_at').range(from, to));

  const ids = [...new Set(sigs.map((s) => s.entity_id))];
  const ent = new Map<string, { name: string; domain: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('entities').select('id, name, attributes').in('id', ids.slice(i, i + 200));
    for (const e of (data ?? []) as any[]) ent.set(e.id, { name: e.name, domain: (e.attributes?.domain ?? '').toLowerCase() });
  }

  let checked = 0, offCompany = 0;
  const byMonth = new Map<string, { n: number; bad: number }>();
  const offenders: Array<{ name: string; url: string; when: string }> = [];

  for (const s of sigs) {
    const e = ent.get(s.entity_id);
    if (!e) continue;
    const url = s.structured_tags?.url ?? '';
    if (!url) continue;
    checked++;
    const page = { title: s.body_for_embedding ?? '', url, text: s.body_for_embedding ?? '' };
    const ok = pageMentionsEntity(e.name, e.domain, page);
    const m = (s.observed_at ?? '').slice(0, 7);
    const row = byMonth.get(m) ?? { n: 0, bad: 0 };
    row.n++; if (!ok) row.bad++;
    byMonth.set(m, row);
    if (!ok) { offCompany++; offenders.push({ name: e.name, url, when: (s.observed_at ?? '').slice(0, 10) }); }
  }

  console.log(`research_result signals with a url: ${checked}`);
  console.log(`never name their own company:       ${offCompany} (${checked ? (offCompany / checked * 100).toFixed(1) : 0}%)`);
  console.log(`\nby month observed:`);
  for (const [m, r] of [...byMonth.entries()].sort()) {
    console.log(`  ${m}  ${String(r.n).padStart(5)} signals  ${String(r.bad).padStart(4)} off-company (${(r.bad / r.n * 100).toFixed(0)}%)`);
  }
  if (LIST) {
    console.log(`\noff-company signals:`);
    for (const o of offenders.slice(0, 80)) console.log(`  ${o.when}  ${o.name.slice(0, 24).padEnd(24)} ${o.url.slice(0, 90)}`);
  } else {
    console.log(`\n(--list to print them)`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
