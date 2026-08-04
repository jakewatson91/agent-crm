/**
 * Backfill signals.structured_tags.published_at from the URL, for signals that
 * were ingested before resolvePublishedDate started reading URL paths.
 *
 * The 2026-07-31 published-date work was forward-only by necessity: the raw page
 * text was never persisted, so a signal that recorded a wrong provider date has
 * nothing to recover from. The URL is different — it IS persisted, in
 * structured_tags.url — so every signal whose path carries /YYYY/MM(/DD) can be
 * dated retroactively with no LLM call and no re-fetch.
 *
 * Only fills blanks. Never overrules a published_at that is already set: that
 * tie-break belongs to resolvePublishedDate at ingest, where the provider's
 * claim is also in hand.
 *
 * Filling a blank usually makes a source LOOK OLDER, and that is the point. An
 * undated signal is exempt from the freshness floor so evergreen pages survive;
 * a URL of /2025/03/ says this is a dated post that hid its date, and it should
 * face the floor like any other article. Expect some accounts to lose triggers
 * they should never have had.
 *
 * Usage: tsx scripts/backfill_url_published_dates.ts          (dry run)
 *        tsx scripts/backfill_url_published_dates.ts --apply
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { publishedDateFromUrl } from '../packages/tools/src/published_date.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');

async function main() {
  const rows: Array<{ id: string; structured_tags: Record<string, unknown> | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('signals').select('id, structured_tags')
      .eq('workspace_id', WS).order('id').range(from, from + 999);
    if (error) throw error;
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  console.log(`${rows.length} signals in workspace`);

  const fixes: Array<{ id: string; url: string; date: string }> = [];
  let alreadyDated = 0, noUrl = 0, noDateInUrl = 0;
  for (const r of rows) {
    const t = (r.structured_tags ?? {}) as Record<string, unknown>;
    if (t.published_at) { alreadyDated++; continue; }
    const url = typeof t.url === 'string' ? t.url : '';
    if (!url) { noUrl++; continue; }
    const d = publishedDateFromUrl(url);
    if (!d) { noDateInUrl++; continue; }
    fixes.push({ id: r.id, url, date: d });
  }

  console.log(`  already dated      : ${alreadyDated}`);
  console.log(`  no url on signal   : ${noUrl}`);
  console.log(`  url carries no date: ${noDateInUrl}`);
  console.log(`  RECOVERABLE        : ${fixes.length}`);

  const byYear = new Map<string, number>();
  for (const f of fixes) byYear.set(f.date.slice(0, 4), (byYear.get(f.date.slice(0, 4)) ?? 0) + 1);
  console.log(`\n  by year: ${[...byYear.entries()].sort().map(([y, n]) => `${y}:${n}`).join('  ')}`);
  console.log('\n  sample:');
  for (const f of fixes.slice(0, 8)) console.log(`    ${f.date.slice(0, 10)}  ${f.url.slice(0, 105)}`);

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return; }

  let done = 0;
  for (const f of fixes) {
    const orig = rows.find((r) => r.id === f.id)!;
    const tags = { ...((orig.structured_tags ?? {}) as Record<string, unknown>), published_at: f.date, published_at_source: 'url' };
    const { error } = await sb.from('signals').update({ structured_tags: tags }).eq('id', f.id);
    if (error) { console.log(`  ERROR ${f.id.slice(0, 8)}: ${error.message}`); continue; }
    done++;
    if (done % 100 === 0) process.stdout.write(` ${done}`);
  }
  console.log(`\n✓ dated ${done} signals from their URL`);
}
main().catch((e) => { console.error(e); process.exit(1); });
