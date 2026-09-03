import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

/**
 * One-off: delete the fact rows and creating events for the four score
 * dimensions that 7fd71bc stopped writing (industry_match, stage_match,
 * recency, graph_proximity).
 *
 * Every one of these numbers is also inside the icp_fit_breakdown JSON on the
 * same entity, written on the same pass, which is where score_explain.ts and
 * the entity page have always read them from. The separate row per dimension
 * was a duplicate that nothing computed from. The fix stopped new ones; this
 * clears the ones already written, and the assert_fact / supersede_fact events
 * behind them, which is where most of the bytes actually are.
 *
 * Order matters. facts.supersedes is a self-FK with NO ACTION, so a chain has
 * to come out newest-first or a batch deletes a row another batch still points
 * at. events cannot be deleted over PostgREST at all (0001 revokes DELETE from
 * every role including service_role), so this runs on the direct connection
 * rather than through the API, which also means no 8s statement_timeout and no
 * URL-length ceiling on the id list.
 *
 *   npx tsx scripts/_prune_dead_score_rows.ts           # measure only
 *   npx tsx scripts/_prune_dead_score_rows.ts --apply   # delete
 */

const DEAD = ['score_industry_match', 'score_stage_match', 'score_recency', 'score_graph_proximity'];
const APPLY = process.argv.includes('--apply');
const BATCH = 5000;

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

async function q(label: string, sql: string, params: unknown[] = []) {
  const r = await c.query(sql, params);
  console.log(`\n== ${label}`);
  for (const row of r.rows) console.log('  ', JSON.stringify(row));
  return r.rows;
}

async function main() {
  await c.connect();
  await c.query("set statement_timeout = '600s'");

  await q('db size', 'select pg_size_pretty(pg_database_size(current_database())) as total');

  await q('table sizes', `
    select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as total,
           pg_size_pretty(pg_relation_size(c.oid)) as heap, s.n_live_tup
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc limit 8`);

  await q('dead rows by workspace', `
    select w.name, f.predicate, count(*)
    from facts f join workspaces w on w.id = f.workspace_id
    where f.predicate = any($1) group by 1, 2 order by 3 desc`, [DEAD]);

  await q('dead rows total', `
    select count(*) as rows, pg_size_pretty(sum(pg_column_size(f.*))::bigint) as heap
    from facts f where f.predicate = any($1)`, [DEAD]);

  await q('their events', `
    select e.action, count(*), pg_size_pretty(sum(pg_column_size(e.*))::bigint) as heap
    from events e
    where e.id in (select source_event_id from facts where predicate = any($1))
    group by 1 order by 2 desc`, [DEAD]);

  // ---- safety: nothing outside the set may depend on it ----
  const guards = await q('SAFETY (all must be 0)', `
    select 'facts outside the set pointing in' as check, count(*)::int as n from facts a
      where a.supersedes in (select id from facts where predicate = any($1)) and a.predicate <> all($1)
    union all
    select 'events with a child event', count(*)::int from events ch
      where ch.parent_event_id in (select source_event_id from facts where predicate = any($1))
    union all
    select 'signals on those events', count(*)::int from signals
      where source_event_id in (select source_event_id from facts where predicate = any($1))
    union all
    select 'posts on those events', count(*)::int from channel_posts
      where source_event_id in (select source_event_id from facts where predicate = any($1))
    union all
    select 'gates on those events', count(*)::int from gates
      where source_event_id in (select source_event_id from facts where predicate = any($1))
    union all
    select 'posts citing a dead row (repaired, not blocking)', count(*)::int from channel_posts p
      where exists (select 1 from unnest(p.cites) x
                    where x in (select id from facts where predicate = any($1)))`, [DEAD]);

  // cites is a uuid[] with no foreign key, so a deleted row leaves a live id in
  // the array and the post's "trace" link resolves to nothing. Measured before
  // the first run: 45 decision posts, each citing 7 score facts of which 4 are
  // dead. Trimming leaves 3 — signal_strength, evidence_depth and the total,
  // which is exactly the set selectAction actually read to make that decision.
  // So the trim is not damage control, it makes the trace honest.
  const blocking = (guards as Array<{ check: string; n: number }>)
    .filter((g) => g.n > 0 && !g.check.includes('repaired'));
  if (!APPLY) {
    console.log(`\nmeasure only. ${blocking.length ? `${blocking.length} guard(s) non-zero — read them before applying.` : 'guards clear.'}`);
    await c.end();
    return;
  }
  if (blocking.length) {
    console.error(`\nrefusing to delete: ${blocking.map((g) => `${g.check}=${g.n}`).join(', ')}`);
    await c.end();
    process.exit(1);
  }

  // ---- trim dangling cites, then delete chains newest-first ----
  const trimmed = await c.query(
    `update channel_posts p
        set cites = (select coalesce(array_agg(x), '{}'::uuid[]) from unnest(p.cites) x
                     where x not in (select id from facts where predicate = any($1)))
      where exists (select 1 from unnest(p.cites) x
                    where x in (select id from facts where predicate = any($1)))`, [DEAD]);
  console.log(`\n  posts re-cited: ${trimmed.rowCount}`);

  let facts = 0;
  for (;;) {
    const r = await c.query(
      `delete from facts where id in (
         select id from facts where predicate = any($1) order by created_at desc limit $2
       )`, [DEAD, BATCH]);
    facts += r.rowCount ?? 0;
    process.stdout.write(`\r  facts deleted: ${facts}`);
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  console.log('');

  // Same rule prune_events enforces: an event no fact points at any more.
  // Scoped to the two fact-writing actions so an unrelated orphan elsewhere in
  // the log is not swept up with them.
  let events = 0;
  for (;;) {
    const r = await c.query(
      `delete from events where id in (
         select id from events e
          where e.action in ('assert_fact', 'supersede_fact')
            and not exists (select 1 from facts f where f.source_event_id = e.id)
          limit $1
       )`, [BATCH]);
    events += r.rowCount ?? 0;
    process.stdout.write(`\r  events deleted: ${events}`);
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  console.log('');

  await c.query('vacuum (analyze) facts');
  await c.query('vacuum (analyze) events');

  await q('db size after', 'select pg_size_pretty(pg_database_size(current_database())) as total');
  await q('table sizes after', `
    select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as total, s.n_live_tup
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc limit 8`);
  console.log(`\ndeleted ${facts} facts, ${events} events`);
  await c.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
