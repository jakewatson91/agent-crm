-- L3: subscription embeddings learn from positive matches.
--
-- A "positive" is a signal that matched a subscription AND the enricher
-- extracted >= 1 fact from the resulting agent run (recorded as an
-- agent_dispatch_result event with ok=true, facts_asserted>=1).
--
-- The subscriptionDriftLearner cron blends positive signal embeddings into
-- the learned_centroid via EMA. Old subscriptions keep behaving identically
-- until the learner has touched them (matcher uses greatest(seed, learned)).

alter table subscriptions
  add column if not exists learned_centroid vector(1536),
  add column if not exists learned_positive_count integer not null default 0,
  add column if not exists learned_updated_at timestamptz;

-- Index for cheap nearest-neighbor on the centroid. HNSW matches the existing
-- index on semantic_embedding (line 163 of 0001_init.sql) so query planning
-- stays consistent.
create index if not exists subscriptions_learned_centroid_hnsw
  on subscriptions using hnsw (learned_centroid vector_cosine_ops)
  where learned_centroid is not null;

-- Rewrite the matcher to consider both the seed embedding and the learned
-- centroid. Subscriptions with no learned centroid fall back to seed-only,
-- so this is a no-op for everything the L3 cron hasn't touched yet.
create or replace function match_signal_to_subscriptions(p_signal_id uuid)
returns table (subscription_id uuid, owner_kind subscription_owner_kind, owner_id text, action_on_match text, similarity numeric) as $$
  select
    s.id,
    s.owner_kind,
    s.owner_id,
    s.action_on_match,
    greatest(
      1 - (s.semantic_embedding <=> sig.embedding),
      case when s.learned_centroid is null then 0
           else 1 - (s.learned_centroid <=> sig.embedding) end
    )::numeric as similarity
  from signals sig
  join subscriptions s
    on s.workspace_id = sig.workspace_id
   and s.active
   and (s.structured_filter = '{}'::jsonb or sig.structured_tags @> s.structured_filter)
  where sig.id = p_signal_id
    and greatest(
      1 - (s.semantic_embedding <=> sig.embedding),
      case when s.learned_centroid is null then 0
           else 1 - (s.learned_centroid <=> sig.embedding) end
    ) >= s.threshold
  order by similarity desc;
$$ language sql stable;
