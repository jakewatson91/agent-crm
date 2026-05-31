-- 0036: portability — reserve the `_` attribute namespace for connector plumbing.
--
-- The shared prose renderer (renderAttributesProse) now drops any attribute key
-- starting with `_` instead of naming specific connector keys, and the archive
-- sweep reads a generic `_watched_by_source` flag instead of attributes.ats.
-- This migration brings existing rows in line so nothing leaks or gets archived:
--   1. rename the scalar plumbing keys connectors wrote (discovered_via /
--      search_query / source_url) to their `_`-prefixed form, preserving values.
--   2. backfill `_watched_by_source: true` on entities the ATS connector already
--      adopted (a real board hint), so the sweep keeps protecting them.
-- A fresh fork has no rows, so this is a no-op there.

update entities
set attributes =
  (attributes - 'discovered_via' - 'search_query' - 'source_url')
  || (case when attributes ? 'discovered_via' then jsonb_build_object('_discovered_via', attributes->'discovered_via') else '{}'::jsonb end)
  || (case when attributes ? 'search_query'   then jsonb_build_object('_search_query',   attributes->'search_query')   else '{}'::jsonb end)
  || (case when attributes ? 'source_url'     then jsonb_build_object('_source_url',     attributes->'source_url')     else '{}'::jsonb end)
where attributes ?| array['discovered_via', 'search_query', 'source_url'];

update entities
set attributes = attributes || jsonb_build_object('_watched_by_source', true)
where attributes->'ats'->>'provider' is not null
  and attributes->'ats'->>'provider' <> 'none';
