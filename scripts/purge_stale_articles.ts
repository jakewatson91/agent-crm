/**
 * Purge signals whose article was ALREADY past the freshness floor on the day
 * the signal was written, plus the facts extracted from them.
 *
 * Why that set and not "everything older than the floor today": a signal that
 * was fresh when ingested and has since aged past the floor is not a defect,
 * it is evidence getting old, and age decay already discounts it. The defect is
 * a result that should never have cleared the gate — the own_site scope was
 * exempt from the age check until 209666c (2026-07-29), which let a 2013 Plex
 * support page and a 2007 CBSNews story in as outreach hooks. Pass
 * `--include-aged` to widen the purge to the aged-out set as well.
 *
 * Dates the enricher later corrected downward (published_at_source=content) are
 * judged on the corrected date, which is the whole point of the correction: the
 * page really was from 2020, the search provider just did not say so.
 *
 * Deletion order matters. facts.signal_id is ON DELETE SET NULL, so dropping a
 * signal first would orphan its facts instead of removing them, and
 * facts.supersedes has no ON DELETE clause, so a surviving row pointing into
 * the delete set blocks the delete outright. Both are handled below.
 *
 * Usage:
 *   tsx scripts/purge_stale_articles.ts                  # dry run, all workspaces
 *   tsx scripts/purge_stale_articles.ts --ws <uuid>      # one workspace
 *   tsx scripts/purge_stale_articles.ts --include-aged   # widen to aged-out signals
 *   tsx scripts/purge_stale_articles.ts --apply          # actually delete
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const INCLUDE_AGED = process.argv.includes('--include-aged');
const WS_ARG = (() => {
  const i = process.argv.indexOf('--ws');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const DEFAULT_FLOOR_DAYS = 30;
const PAGE = 1000;

interface SignalRow {
  id: string;
  entity_id: string;
  type: string;
  created_at: string;
  structured_tags: Record<string, unknown> | null;
}

/**
 * Every row of a table for one workspace, paged past the 1000-row read cap.
 *
 * The caller's builder must NOT set its own order. Paging with `.range()` over
 * an unordered query is undefined in Postgres: pages overlap and drop rows, and
 * two runs disagree. That is not hypothetical here — the first version of this
 * script counted 442 facts to delete and then 544 for the same unchanged data.
 * Ordering by id is arbitrary but stable, which is all paging needs.
 */
async function readAll<T extends { id: string | number }>(
  sb: ReturnType<typeof createClient>,
  build: (from: number, to: number) => any,
): Promise<T[]> {
  const byId = new Map<string | number, T>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const got = (data ?? []) as T[];
    for (const r of got) byId.set(r.id, r);
    if (got.length < PAGE) break;
  }
  return [...byId.values()];
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const wsq = sb.from('workspaces').select('id, name, policy');
  const { data: wss, error: wsErr } = await (WS_ARG ? wsq.eq('id', WS_ARG) : wsq);
  if (wsErr) throw wsErr;

  console.log(APPLY ? '*** APPLY MODE — rows will be deleted ***' : 'dry run — nothing will be deleted');
  console.log(INCLUDE_AGED ? 'scope: stale-at-write AND aged-out\n' : 'scope: stale-at-write only\n');

  for (const ws of (wss ?? []) as Array<{ id: string; name: string; policy: any }>) {
    const floor = ws.policy?.research?.max_age_days ?? DEFAULT_FLOOR_DAYS;
    const floorMs = floor * 86400_000;

    const signals = await readAll<SignalRow>(sb, (from, to) =>
      sb.from('signals').select('id, entity_id, type, created_at, structured_tags')
        .eq('workspace_id', ws.id).order('id').range(from, to));

    const staleAtWrite: SignalRow[] = [];
    const agedOut: SignalRow[] = [];
    for (const s of signals) {
      const pub = s.structured_tags?.published_at as string | undefined;
      if (!pub) continue;                       // undated evergreen pages are exempt by design
      const pubMs = Date.parse(pub);
      if (!Number.isFinite(pubMs)) continue;
      if (Date.parse(s.created_at) - pubMs > floorMs) staleAtWrite.push(s);
      else if (Date.now() - pubMs > floorMs) agedOut.push(s);
    }

    const target = INCLUDE_AGED ? [...staleAtWrite, ...agedOut] : staleAtWrite;
    const targetIds = new Set(target.map((s) => s.id));

    console.log(`=== ${ws.name} (${ws.id.slice(0, 8)}) — floor ${floor}d — ${signals.length} signals`);
    console.log(`  stale at write (the defect): ${staleAtWrite.length}`);
    console.log(`  aged out since (fresh when ingested): ${agedOut.length}${INCLUDE_AGED ? ' — INCLUDED' : ' — left alone'}`);
    if (!targetIds.size) { console.log('  nothing to purge\n'); continue; }

    // Every fact in the workspace, not just the ones bound to a signal. The
    // signal-bound subset is what gets deleted, but the supersedes check below
    // has to see the whole table: a fact with signal_id null (legacy, or
    // asserted outside an enricher path) can still point at a doomed row, and
    // scoping this read to signal-bound facts reported zero entanglement while
    // Postgres rejected the delete on facts_supersedes_fkey.
    const allFacts = await readAll<{ id: string; signal_id: string | null; supersedes: string | null; subject_entity: string; predicate: string; object_text: string | null }>(
      sb, (from, to) => sb.from('facts').select('id, signal_id, supersedes, subject_entity, predicate, object_text')
        .eq('workspace_id', ws.id).order('id').range(from, to));

    const doomedFacts = allFacts.filter((f) => f.signal_id && targetIds.has(f.signal_id));
    const doomedFactIds = new Set(doomedFacts.map((f) => f.id));
    const activeDoomed = doomedFacts.filter((f) => !f.supersedes);

    // Surviving rows that point into the delete set via supersedes. The FK has
    // no ON DELETE clause, so these must be repointed before the delete runs.
    const danglers = allFacts.filter((f) => f.supersedes && doomedFactIds.has(f.supersedes) && !doomedFactIds.has(f.id));

    // Posts that cite one of those facts. channel_posts.cites is a bare uuid[]
    // with no foreign key, so a delete leaves the id dangling and the provenance
    // walk behind that draft stops resolving. Counted here because a draft built
    // on a 2016 article is itself suspect and Jake should see the number before
    // agreeing to the delete.
    const posts = await readAll<{ id: string; kind: string; created_at: string; cites: string[] | null; channel_id: string }>(
      sb, (from, to) => sb.from('channel_posts')
        .select('id, kind, created_at, cites, channel_id, channels!inner(workspace_id)')
        .eq('channels.workspace_id', ws.id).not('cites', 'eq', '{}').order('id').range(from, to));
    const citingPosts = posts.filter((p) => (p.cites ?? []).some((c) => doomedFactIds.has(c)));
    const citingByKind = new Map<string, number>();
    for (const p of citingPosts) citingByKind.set(p.kind, (citingByKind.get(p.kind) ?? 0) + 1);

    const years = new Map<string, number>();
    for (const s of target) {
      const y = String(new Date(Date.parse(s.structured_tags!.published_at as string)).getUTCFullYear());
      years.set(y, (years.get(y) ?? 0) + 1);
    }
    const entities = new Set(target.map((s) => s.entity_id));

    console.log(`  -> signals to delete: ${targetIds.size}  across ${entities.size} accounts`);
    console.log(`     by article year: ${[...years.entries()].sort().map(([y, n]) => `${y}:${n}`).join('  ')}`);
    console.log(`  -> facts to delete: ${doomedFacts.length}  (${activeDoomed.length} currently active)`);
    console.log(`  -> surviving facts whose supersedes points into the set: ${danglers.length} (will be set null)`);
    console.log(`  -> existing posts citing a doomed fact: ${citingPosts.length}${citingPosts.length ? `  (${[...citingByKind.entries()].map(([k, n]) => `${k}:${n}`).join(' ')})` : ''}`);

    if (!APPLY) {
      console.log('\n  sample of what goes (oldest 10):');
      for (const s of [...target].sort((a, b) =>
        Date.parse(a.structured_tags!.published_at as string) - Date.parse(b.structured_tags!.published_at as string)).slice(0, 10)) {
        const t = s.structured_tags!;
        const f = doomedFacts.filter((x) => x.signal_id === s.id);
        console.log(`    ${String(t.published_at).slice(0, 10)}  angle=${t.research_angle ?? '-'}  facts=${f.length}  ${String(t.url ?? '').slice(0, 80)}`);
        for (const x of f.slice(0, 3)) console.log(`        ${x.predicate}: ${String(x.object_text ?? '').slice(0, 90)}`);
      }
      console.log('');
      continue;
    }

    // --- apply ---
    const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

    for (const ids of chunk(danglers.map((f) => f.id), 200)) {
      const { error } = await sb.from('facts').update({ supersedes: null }).in('id', ids);
      if (error) throw new Error(`repoint supersedes: ${error.message}`);
    }
    let factsDeleted = 0;
    for (const ids of chunk([...doomedFactIds], 200)) {
      const { error, count } = await sb.from('facts').delete({ count: 'exact' }).in('id', ids);
      if (error) throw new Error(`delete facts: ${error.message}`);
      factsDeleted += count ?? 0;
    }
    let signalsDeleted = 0;
    for (const ids of chunk([...targetIds], 200)) {
      const { error, count } = await sb.from('signals').delete({ count: 'exact' }).in('id', ids);
      if (error) throw new Error(`delete signals: ${error.message}`);
      signalsDeleted += count ?? 0;
    }
    console.log(`  DELETED: ${factsDeleted} facts, ${signalsDeleted} signals, ${danglers.length} supersedes pointers cleared\n`);
  }
}
main();
