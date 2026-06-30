-- 0043: add body_hash generated column to signals + aggregation RPC for sweep.
--
-- Problem: sweepWorkspace fetches body_for_embedding for all signals in 24h, 48h,
-- and 7d windows just to count unique bodies. At ~606 signals/day × ~2KB each,
-- a single sweep run was pulling ~11MB from Supabase. This fires at every session
-- start, so multiple daily sessions = the egress spike.
--
-- Fix:
-- 1. Add body_hash TEXT GENERATED ALWAYS AS (md5(body_for_embedding)) STORED.
--    Sweep can now select body_hash (32 bytes) instead of body_for_embedding (~2KB).
-- 2. Add count_daily_unique_signals() RPC for the 7d cost-per-signal calculation.
--    Replaces a fetchAll of ~4,200 rows with a single 7-row aggregation.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS body_hash TEXT GENERATED ALWAYS AS (md5(body_for_embedding)) STORED;

-- Aggregation RPC: returns (day_offset INT, unique_count BIGINT) for each calendar
-- day in the last N days. day_offset=0 is today, 1=yesterday, etc.
CREATE OR REPLACE FUNCTION count_daily_unique_signals(
  p_workspace_id UUID,
  p_since        TIMESTAMPTZ
)
RETURNS TABLE(day_offset INT, unique_count BIGINT)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT day_offset, COUNT(DISTINCT body_hash) AS unique_count
  FROM (
    SELECT
      FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)::INT AS day_offset,
      body_hash
    FROM signals
    WHERE workspace_id = p_workspace_id
      AND created_at >= p_since
      AND body_hash IS NOT NULL
  ) sub
  WHERE day_offset < 7
  GROUP BY day_offset
$$;
