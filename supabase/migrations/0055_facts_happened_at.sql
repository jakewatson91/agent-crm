-- 0055: when the thing in a fact actually happened.
--
-- facts.observed_at is stamped now() at assertion, so it records when WE wrote
-- the row down and nothing about the world. Three separate places re-derive a
-- fact's time meaning from that plus whatever date the source page carried, each
-- with its own guesswork: the recency term in score_facts, ~500 words of the
-- drafter prompt teaching the model to tell "published on" from "we recorded it
-- on", and the research freshness check. The shared failure is an unknown date
-- defaulting to today, which has now been fixed separately in three places and
-- keeps coming back somewhere else.
--
-- happened_at is the one place the answer lives. NULL is the common and correct
-- value: it means "this fact is not an event" (a description, a market they
-- serve, the encoder they run on) OR "it is an event and nobody could date it".
-- Neither is a reason to treat it as fresh. Only the enricher writes it, because
-- it is the only stage that reads the page.
--
-- Deliberately NOT part of content_hash. A fact's identity is the claim, so
-- re-asserting the same claim from a second source still dedups; the date it
-- first carried is the one that stands.

ALTER TABLE facts ADD COLUMN IF NOT EXISTS happened_at timestamptz;

COMMENT ON COLUMN facts.happened_at IS
  'When the event in this fact happened. NULL = not an event, or an event nobody could date. Never defaults to now().';

-- The anchor pick asks one question per account: does this entity hold a fact
-- that happened inside the freshness window. Partial, because the majority of
-- rows are state and will never be scanned by it.
--
-- No supersedes predicate here on purpose. The current row in this codebase is
-- the one no other row POINTS AT via supersedes, not the one whose own supersedes
-- is null (that reads the stale original — the bug behind the 917-fact collapse
-- and the routing-preview mis-ranking). Callers fetch and apply that rule in
-- code, so an index that pre-filtered on supersedes would serve the wrong query.
CREATE INDEX IF NOT EXISTS facts_happened_at_idx
  ON facts(workspace_id, subject_entity, happened_at DESC)
  WHERE happened_at IS NOT NULL;
