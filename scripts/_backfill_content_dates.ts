/**
 * Backfill publication dates onto signals that carry none, by reading the
 * dateline off the page text we already stored.
 *
 * Why this exists: an undated signal is exempt from the research freshness floor
 * and reaches the drafter labelled "undated source, we recorded it <today>". For
 * a genuinely evergreen page (a customer list, a pricing page) that is correct.
 * For an article whose dateline is printed at the top and which no other date
 * source could see, it is wrong, and it put an 11-year-old STARZPLAY quote from a
 * 2021 JW Player case study into the active fact set as a current pain.
 *
 * The enricher has read datelines since 92e4e0e (2026-07-31 10:05), so this only
 * targets signals ingested before that. It re-reads `body_for_embedding`, which
 * means no fetches and no API spend.
 *
 * The date can only ever be FILLED here, never moved: every signal in scope has
 * published_at null. Filling a blank can only subject a source to more scrutiny
 * than it faced before, so a misread costs one binned result rather than putting
 * stale news in front of a prospect. Same asymmetry applyContentDate is built on,
 * and every candidate is passed through it for the future/absurdly-old checks.
 *
 * Dry run by default. Pass --apply to write.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchAll, chunk } from '../packages/tools/src/paginate.ts';
import { applyContentDate } from '../packages/tools/src/published_date.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.BACKFILL_WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');

/** The enricher started reading datelines here; signals after it already had their chance. */
const DATELINE_FIX = Date.parse('2026-07-31T10:05:00Z');

/**
 * How far into the page a dateline still counts as the page's own. A byline sits
 * in the first few lines; a date further down belongs to the story, not to the
 * act of publishing it ("the deal closed in March 2019"), and reading those as
 * publication dates would date pages by whatever they happen to talk about.
 */
const HEAD_CHARS = 400;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

/** Ordered by how much the format tells us. First match in the head wins. */
const PATTERNS: Array<{ re: RegExp; pick: (m: RegExpMatchArray) => [number, number, number] | null }> = [
  // 2021-09-08
  { re: /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/i, pick: (m) => [+m[1], +m[2], +m[3]] },
  // September 8, 2021  /  Sep 8 2021
  //
  // No word boundary after the year, unlike the numeric formats below. Stripping
  // markup routinely welds the byline to whatever label followed it, and the
  // STARZPLAY page this was written for reads "September 8, 20212 min read" —
  // with \b the whole dateline is invisible. A month name plus a 1-2 digit day
  // pins the format hard enough that the next four digits can only be the year,
  // so trailing junk is safe to ignore here in a way it would not be for a bare
  // run of digits.
  { re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2}),?\\s+((?:19|20)\\d{2})`, 'i'), pick: (m) => [+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]] },
  // 6 July 2023  /  06 Aug 2025
  { re: new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\s+((?:19|20)\\d{2})`, 'i'), pick: (m) => [+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]] },
  // 23/04/2026. Only when one component is >12, which settles day-vs-month on its
  // own. An ambiguous 04/07/2025 is skipped rather than guessed: the publisher's
  // locale is not in the row, and guessing wrong moves a date by up to 11 months.
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/,
    pick: (m) => {
      const [a, b, y] = [+m[1], +m[2], +m[3]];
      if (a > 12 && b <= 12) return [y, b, a];   // DD/MM
      if (b > 12 && a <= 12) return [y, a, b];   // MM/DD
      if (a === b && a <= 12) return [y, a, b];  // same either way
      return null;
    },
  },
];

function datelineFrom(body: string): { iso: string; matched: string } | null {
  const head = body.slice(0, HEAD_CHARS).replace(/\s+/g, ' ');
  let best: { iso: string; matched: string; at: number } | null = null;
  for (const p of PATTERNS) {
    const m = head.match(p.re);
    if (!m || m.index == null) continue;
    const parts = p.pick(m);
    if (!parts) continue;
    const [y, mo, d] = parts;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (best == null || m.index < best.at) best = { iso, matched: m[0], at: m.index };
  }
  return best ? { iso: best.iso, matched: best.matched } : null;
}

async function main() {
  // Only signals that actually carry an active fact. Dating a signal nothing was
  // extracted from changes no reader's behaviour.
  const facts = await fetchAll<{ id: string; predicate: string; signal_id: string | null; supersedes: string | null }>(
    (from, to) => sb.from('facts').select('id, predicate, signal_id, supersedes')
      .eq('workspace_id', WS).order('id').range(from, to));
  const pointed = new Set(facts.map((f) => f.supersedes).filter(Boolean));
  const SKIP = new Set(['icp_fit', 'icp_fit_breakdown', 'contact_score', 'dropped_until', 'outreach_cooldown_until']);
  const active = facts.filter((f) => !pointed.has(f.id) && !f.predicate.startsWith('score_') && !SKIP.has(f.predicate) && f.signal_id);

  const factsBySignal = new Map<string, number>();
  for (const f of active) factsBySignal.set(f.signal_id!, (factsBySignal.get(f.signal_id!) ?? 0) + 1);

  const sigs: any[] = [];
  for (const c of chunk([...factsBySignal.keys()], 150)) {
    const { data, error } = await sb.from('signals')
      .select('id, type, created_at, structured_tags, body_for_embedding').in('id', c);
    if (error) throw new Error(error.message);
    sigs.push(...(data ?? []));
  }

  const scope = sigs.filter((s) => !(s.structured_tags ?? {}).published_at && Date.parse(s.created_at) < DATELINE_FIX);
  console.log(`${sigs.length} fact-bearing signals; ${scope.length} undated and ingested before the 07-31 dateline fix\n`);

  const hits: Array<{ s: any; iso: string; matched: string; facts: number }> = [];
  let noDateline = 0, rejected = 0;
  for (const s of scope) {
    const found = datelineFrom(String(s.body_for_embedding ?? ''));
    if (!found) { noDateline++; continue; }
    // published_at is null for everything here, so this fills a blank and applies
    // the plausibility floor/ceiling. Null back means the model of a date failed.
    const ok = applyContentDate(null, found.iso);
    if (!ok) { rejected++; console.log(`  REJECTED ${found.iso} (implausible) from "${found.matched}" — ${s.structured_tags?.url ?? s.id}`); continue; }
    hits.push({ s, iso: ok, matched: found.matched, facts: factsBySignal.get(s.id) ?? 0 });
  }

  const FLOOR_DAYS = 90;
  hits.sort((a, b) => a.iso.localeCompare(b.iso));
  console.log(`${hits.length} datable, ${noDateline} no dateline in the first ${HEAD_CHARS} chars, ${rejected} rejected as implausible\n`);
  let staleFacts = 0;
  for (const h of hits) {
    const ageDays = Math.round((Date.now() - Date.parse(h.iso)) / 86_400_000);
    const stale = ageDays > FLOOR_DAYS;
    if (stale) staleFacts += h.facts;
    console.log(`${h.iso.slice(0, 10)}  ${String(ageDays + 'd').padStart(6)}  ${stale ? 'PAST FLOOR' : 'in window '}  ${String(h.facts) + ' fact(s)'}`);
    console.log(`   matched "${h.matched}"  in: ${String(h.s.body_for_embedding ?? '').slice(0, 150).replace(/\s+/g, ' ')}`);
    console.log(`   ${h.s.structured_tags?.url ?? '(no url)'}\n`);
  }
  console.log(`facts whose source turns out older than the ${FLOOR_DAYS}-day floor: ${staleFacts}`);

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return; }

  let written = 0;
  for (const h of hits) {
    const tags = (h.s.structured_tags ?? {}) as Record<string, unknown>;
    const { error } = await sb.from('signals').update({
      structured_tags: { ...tags, published_at: h.iso, published_at_source: 'content_backfill', published_at_matched: h.matched.slice(0, 64) },
    }).eq('id', h.s.id);
    if (error) { console.warn(`  write failed for ${h.s.id}: ${error.message}`); continue; }
    written++;
  }
  console.log(`\nwrote published_at to ${written} of ${hits.length} signals.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
