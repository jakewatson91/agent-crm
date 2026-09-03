-- 0060: let the fact-history rollup keep one reading per MONTH, not only one
-- per day.
--
-- 0058 chose a calendar day as the grain and, on this database, that turned out
-- to reach almost nothing. It only drops a replaced reading when a LATER
-- reading exists on the same day, and scoring runs about once a day per
-- account, so an account's history is one row per day with nothing to collapse.
-- Measured 2026-09-03 across the two workspaces with retention on: 1,225 of
-- 111,228 replaced score rows were eligible at daily grain, and every one of
-- them came from a single burst day (2026-08-04) that had just crossed the
-- 30-day window. Retention ran on 09-01 and 09-02 and correctly deleted zero.
-- At monthly grain the same predicates yield 18,876 rows, and the
-- assert_fact/supersede_fact events behind them clear on the same pass, which
-- is where most of the bytes are (events is 228MB against facts' 112MB).
--
-- What the coarser grain costs, precisely. /api/entities/[entity_id]/score_
-- history walks the full score_total chain and attributes each step's delta to
-- the substantive facts asserted between it and the previous step. Past the
-- retention window that chart keeps one point per month instead of one per day,
-- so an old delta is attributed to a month of facts rather than a day of them.
-- The trend still spans the account's whole life and the current reading is
-- never touched. Inside the window nothing changes at all.
--
-- Which is why the grain is a per-workspace setting (policy.retention.fact_
-- history_grain) and not a new constant here: how far back a customer wants to
-- zoom into their own score history is their call, not ours. Default stays
-- 'day', so a workspace that says nothing keeps exactly the behaviour 0058
-- shipped.
--
-- The old 4-argument function has to be dropped rather than replaced: adding a
-- defaulted 5th parameter creates a second function instead of replacing the
-- first, and a 4-argument call would then be ambiguous between them.

drop function if exists prune_fact_history(uuid, text[], timestamptz, integer);

create or replace function prune_fact_history(
  p_workspace_id uuid,
  p_predicates   text[],
  p_cutoff       timestamptz,
  p_limit        integer default null,
  p_grain        text default 'day'
) returns integer as $$
declare
  v_deleted integer := 0;
  v_rec record;
begin
  if p_predicates is null or array_length(p_predicates, 1) is null then
    return 0;
  end if;

  -- Whitelisted, not passed through to date_trunc: this argument arrives from
  -- workspace config, and date_trunc accepts grains ('year', 'century') that
  -- would collapse an account's entire history into one reading.
  if p_grain is null or p_grain not in ('day', 'month') then
    raise exception 'prune_fact_history: p_grain must be day or month, got %', p_grain;
  end if;

  for v_rec in
    select f.id, f.supersedes
    from facts f
    where f.workspace_id = p_workspace_id
      and f.predicate = any(p_predicates)
      and f.created_at < p_cutoff
      -- superseded: this is a replaced value, never the current reading
      and exists (select 1 from facts s where s.supersedes = f.id)
      -- never the chain's root — see the unique-index note in 0058
      and f.supersedes is not null
      -- not the last reading of its period: a later reading exists inside the
      -- same day (or month), so this one is a redundant intra-period re-read
      and exists (
        select 1 from facts g
        where g.workspace_id = f.workspace_id
          and g.subject_entity = f.subject_entity
          and g.predicate = f.predicate
          and date_trunc(p_grain, g.created_at) = date_trunc(p_grain, f.created_at)
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

grant execute on function prune_fact_history(uuid, text[], timestamptz, integer, text) to service_role, authenticated;
