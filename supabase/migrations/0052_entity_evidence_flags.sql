-- 0052: evidence counts per entity, computed in the database.
--
-- Problem: the score_distribution check drops entities with no substantive facts
-- (they sit at 0 by design and make the scorer look like it is collapsing) and
-- entities that have been dropped. To decide that, sweepWorkspace pulled EVERY
-- live fact row in the workspace — 32,954 of them on the Sudden workspace, 33
-- sequential pages — and counted them in JavaScript. The sweep runs at every
-- session start and on the scheduled health job, so this is the most frequent
-- read in the system.
--
-- Fix: group in Postgres and return one row per entity.
--
-- What counts as "substantive" is NOT duplicated here. isSubstantiveFact
-- (scoring.ts) is the single canonical definition and the sweep passes its
-- ADMIN_PREDICATES list in as p_admin_predicates. The one piece encoded in SQL is
-- the `score_` prefix rule, which that same function applies — keep the two in
-- step if it ever changes. The scorer and the sweep disagreeing about what counts
-- as evidence is a bug this codebase has already shipped once.

CREATE INDEX IF NOT EXISTS facts_ws_live_subject_idx
  ON facts(workspace_id, subject_entity)
  WHERE supersedes IS NULL;

CREATE OR REPLACE FUNCTION entity_evidence_flags(
  p_workspace_id     UUID,
  p_admin_predicates TEXT[],
  p_entities         UUID[] DEFAULT NULL
)
RETURNS TABLE(subject_entity UUID, substantive_facts BIGINT, dropped BOOLEAN)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT
    f.subject_entity,
    COUNT(*) FILTER (
      WHERE NOT (f.predicate = ANY(p_admin_predicates))
        AND f.predicate NOT LIKE 'score\_%'
    ) AS substantive_facts,
    bool_or(f.predicate = 'dropped_until') AS dropped
  FROM facts f
  WHERE f.workspace_id = p_workspace_id
    AND f.supersedes IS NULL
    AND (p_entities IS NULL OR f.subject_entity = ANY(p_entities))
  GROUP BY f.subject_entity
  ORDER BY f.subject_entity
$$;
