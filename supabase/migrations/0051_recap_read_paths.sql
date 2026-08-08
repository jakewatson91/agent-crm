-- 0051: read paths for the recap (sweep + period report).
--
-- Problem: three places needed "the current value of a predicate per entity" and
-- none of them could ask for it, so each faked it in application code:
--
--   1. report.ts prevScoreOf — one round-trip PER SCORED ACCOUNT to find the last
--      icp_fit before the window. On the Sudden workspace that is 1,961 sequential
--      queries and ~2m40s of the 3m20s a `pnpm report` took.
--   2. report.ts latestBreakdown — two more round-trips per rendered account.
--   3. sweep.ts score_distribution — fetched EVERY icp_fit row ever written for the
--      workspace (all superseded versions included) and reduced them client-side.
--      2,378 score writes land in a single day, so this grows without bound.
--
--   Plus domainBackfill, which pulled the full `attributes` jsonb of every account
--   just to count the ones with no domain.
--
-- Fix: two functions that answer those questions in the database.
--
-- latest_facts_before() is the general primitive: DISTINCT ON gives one row per
-- entity — the newest at or before a cutoff — which is exactly what "current
-- score" means. Pass p_cutoff NULL for "now", p_entities NULL for "every entity
-- in the workspace".
--
-- PostgREST caps a function response at 1000 rows like any other, so callers page
-- with .range(). The ORDER BY makes that paging stable.

CREATE INDEX IF NOT EXISTS facts_ws_pred_subj_obs_idx
  ON facts(workspace_id, predicate, subject_entity, observed_at DESC);

CREATE OR REPLACE FUNCTION latest_facts_before(
  p_workspace_id UUID,
  p_predicate    TEXT,
  p_cutoff       TIMESTAMPTZ DEFAULT NULL,
  p_entities     UUID[]      DEFAULT NULL,
  p_inclusive    BOOLEAN     DEFAULT FALSE
)
RETURNS TABLE(subject_entity UUID, object_text TEXT, observed_at TIMESTAMPTZ)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT DISTINCT ON (f.subject_entity)
    f.subject_entity, f.object_text, f.observed_at
  FROM facts f
  WHERE f.workspace_id = p_workspace_id
    AND f.predicate = p_predicate
    AND (p_entities IS NULL OR f.subject_entity = ANY(p_entities))
    AND (
      p_cutoff IS NULL
      OR (p_inclusive AND f.observed_at <= p_cutoff)
      OR (NOT p_inclusive AND f.observed_at < p_cutoff)
    )
  ORDER BY f.subject_entity, f.observed_at DESC
$$;

-- Accounts still waiting on the domain backfill. Mirrors the filter the report
-- used to apply in TypeScript: live (not archived), not a candidate stub, and no
-- non-empty `domain` attribute. `->>` renders JSON true as the text 'true', so the
-- candidate test needs no cast and cannot throw on unexpected values.
CREATE OR REPLACE FUNCTION count_accounts_missing_domain(p_workspace_id UUID)
RETURNS BIGINT
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM entities e
  WHERE e.workspace_id = p_workspace_id
    AND e.archived_at IS NULL
    AND COALESCE(e.attributes->>'_candidate', '') <> 'true'
    AND COALESCE(e.attributes->>'domain', '') = ''
    AND EXISTS (
      SELECT 1 FROM facts f
      WHERE f.workspace_id = e.workspace_id
        AND f.subject_entity = e.id
        AND f.predicate = 'is_a'
        AND f.object_text = 'account'
        AND f.supersedes IS NULL
    )
$$;
