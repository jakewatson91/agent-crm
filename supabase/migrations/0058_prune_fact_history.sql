-- 0058: prune_fact_history() — a rollup, not a delete, for facts whose
-- predicate churns on every scoring pass (score_total and its inputs).
--
-- 2026-08-25: DB back over the Supabase 500MB quota. facts + its two
-- writing events (assert_fact, supersede_fact) turned out to be the whole
-- story: 112,080 of 169,309 fact rows are superseded (replaced) values, and
-- every one of them is scoring output — score_total, score_recency,
-- icp_fit, icp_fit_breakdown, score_evidence_depth, score_industry_match,
-- score_stage_match, score_signal_strength, score_graph_proximity,
-- contact_score. Zero are a dated real-world event (facts.happened_at is
-- null on all of them) and zero are a one-off account fact — this is the
-- scorer overwriting its own output on every pass, in a table designed to
-- never overwrite.
--
-- The existing prune_events() (0039) can't touch any of this: it refuses to
-- delete an event a fact still points to, so as long as the fact row
-- exists, the assert_fact/supersede_fact event that created it is stuck
-- too. Freeing the events table (237MB, 70% of it exactly these two
-- actions) runs through freeing the facts first.
--
-- Deliberately not a plain age-based delete. score_total feeds a real trend
-- chart (/api/entities/[id]/score_history) built by walking its full
-- superseded history — deleting old rows outright would visibly shorten
-- that chart. Instead: keep the LAST reading of each calendar day forever,
-- drop only same-day reads that are older than the cutoff and already
-- superseded by a later day's reading. The trend the chart draws still
-- covers the account's whole life; it just can't zoom into a day older
-- than the window. Every other listed predicate is fetched by that same
-- route and thrown away before rendering (already excluded from
-- isSubstantiveFact() in scoring.ts) — no UI reads their history at all, so
-- collapsing them the same way costs nothing visible.
--
-- The splice: to delete a mid-chain fact X, repoint whatever pointed at X
-- (X's successor, via supersedes = X.id — there can legitimately be more
-- than one, see the fork note in migration 0048's history) at X's own
-- supersedes value, then delete X. The repoint reads X's supersedes value
-- with a live subselect rather than the loop variable captured at query
-- start — PL/pgSQL's FOR-IN-SELECT fetches its result set once, so when
-- several same-day dupes sit back to back in one chain (P -> X -> Y, both P
-- and X eligible), splicing P first live-updates X's supersedes in the
-- table, but the loop's cached copy of X's row still shows the pre-splice
-- value. Reusing that stale copy for X's own splice re-points Y at P's id
-- right after P was deleted — a foreign key violation caught in testing at
-- batch sizes large enough to hit a same-day run of 2+ candidates.
--
-- Never deletes a chain's root (supersedes is null). A root is the only kind
-- of row a splice can turn into a NEW supersedes-is-null row (X's successor
-- inherits X's own supersedes value, and a root's is null), and
-- facts_content_hash_active enforces at most one supersedes-is-null row per
-- (workspace, content_hash). Two forked successors of the same root that
-- happen to carry the same value (the same score recomputing to an
-- identical number from two different runs, still a legitimate fork per
-- migration 0048's history) would both try to become that one null row and
-- collide — caught in testing as a unique-constraint violation once a real
-- fork-with-duplicate-value pair was hit. Splicing only ever writes a
-- NON-null value (some earlier fact's id) when the row being deleted is
-- itself non-root, so this path can't reach that index at all. Leaves one
-- extra row per chain (its true original) that this function will never
-- touch — negligible next to the hundreds of rewrites some chains carry.
--
-- SECURITY DEFINER because deleting from facts should go through one
-- audited, provenance-aware path rather than raw DELETE grants, same
-- reasoning as prune_events. Unlike events, facts.DELETE was never revoked
-- from service_role, but funneling through here keeps the "which rows are
-- eligible" logic in one place instead of duplicated at every call site.
create or replace function prune_fact_history(
  p_workspace_id uuid,
  p_predicates   text[],
  p_cutoff       timestamptz,
  p_limit        integer default null
) returns integer as $$
declare
  v_deleted integer := 0;
  v_rec record;
begin
  if p_predicates is null or array_length(p_predicates, 1) is null then
    return 0;
  end if;

  for v_rec in
    select f.id, f.supersedes
    from facts f
    where f.workspace_id = p_workspace_id
      and f.predicate = any(p_predicates)
      and f.created_at < p_cutoff
      -- superseded: this is a replaced value, never the current reading
      and exists (select 1 from facts s where s.supersedes = f.id)
      -- never the chain's root — see the unique-index note above
      and f.supersedes is not null
      -- not the last reading of its calendar day: a later same-day
      -- reading exists, so this one is a redundant intra-day dupe
      and exists (
        select 1 from facts g
        where g.workspace_id = f.workspace_id
          and g.subject_entity = f.subject_entity
          and g.predicate = f.predicate
          and date_trunc('day', g.created_at) = date_trunc('day', f.created_at)
          and g.created_at > f.created_at
      )
    order by f.created_at asc
    limit coalesce(p_limit, 100000)
  loop
    update facts set supersedes = (select supersedes from facts where id = v_rec.id) where supersedes = v_rec.id;
    delete from facts where id = v_rec.id;
    v_deleted := v_deleted + 1;
  end loop;

  return v_deleted;
end;
$$ language plpgsql security definer;

grant execute on function prune_fact_history(uuid, text[], timestamptz, integer) to service_role, authenticated;
