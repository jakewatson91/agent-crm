/**
 * Daily rate of past-the-floor signals, split by how the article date was
 * settled. Shows whether stale results are still arriving and by which route.
 *
 * Usage: tsx scripts/_chk_old_articles3.ts [days_back=30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const daysBack = Number(process.argv[2] ?? 30);
const supabase = createServerClient();
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const FLOOR = 90;

async function main() {
  const since = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const rows: any[] = [];
  for (let page = 0; page < 10; page++) {
    const res = await supabase
      .from('signals')
      .select('id, type, created_at, structured_tags')
      .eq('workspace_id', WS)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(page * 1000, page * 1000 + 999);
    const got = (res.data ?? []) as any[];
    rows.push(...got);
    if (got.length < 1000) break;
  }

  const byDay = new Map<string, { total: number; stale: number; undated: number; bySrc: Map<string, number> }>();
  for (const r of rows) {
    const day = String(r.created_at).slice(0, 10);
    let d = byDay.get(day);
    if (!d) { d = { total: 0, stale: 0, undated: 0, bySrc: new Map() }; byDay.set(day, d); }
    d.total++;
    const t = r.structured_tags ?? {};
    const pub = t.published_at as string | undefined;
    if (!pub) { d.undated++; continue; }
    const ms = Date.parse(pub);
    if (!Number.isFinite(ms)) continue;
    // Age at the moment the signal was written, not today.
    const ageDays = (Date.parse(r.created_at) - ms) / 86400_000;
    if (ageDays > FLOOR) {
      d.stale++;
      const src = String(t.published_at_source ?? 'provider');
      d.bySrc.set(src, (d.bySrc.get(src) ?? 0) + 1);
    }
  }

  console.log(`day         total  stale(>${FLOOR}d at write)  undated   stale by date source`);
  for (const [day, d] of [...byDay.entries()].sort()) {
    const src = [...d.bySrc.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`${day}  ${String(d.total).padStart(5)}  ${String(d.stale).padStart(10)}  ${String(d.undated).padStart(8)}   ${src}`);
  }

  // Anything genuinely ancient, whenever it was written.
  const old = rows
    .map((r) => ({ r, ms: Date.parse(r.structured_tags?.published_at ?? '') }))
    .filter((x) => Number.isFinite(x.ms) && x.ms < Date.UTC(2019, 0, 1))
    .sort((a, b) => a.ms - b.ms);
  console.log(`\npre-2019 articles among the last ${daysBack}d of signals: ${old.length}`);
  for (const { r, ms } of old) {
    console.log(`  ${new Date(ms).toISOString().slice(0, 10)}  created ${String(r.created_at).slice(0, 10)}  src=${r.structured_tags?.published_at_source ?? 'provider'}  angle=${r.structured_tags?.research_angle ?? '-'}  ${String(r.structured_tags?.url ?? '').slice(0, 90)}`);
  }
}
main();
