-- Move ICP/pitch embedding caches OUT of workspaces.policy.
--
-- workspaces.policy is read in full on nearly every agent operation
-- (scoring, enrichment, connectors, gate notify — ~9 hot code paths each
-- doing `select policy`). The two embedding caches had been nested inside
-- policy, bloating it from ~3 KB of real config to ~79 KB. At tens of
-- thousands of policy reads/day that was ~490 MB/day of Supabase egress for
-- vectors that the policy readers never use.
--
-- Caches now live in their own column. The scorer paths that actually need
-- them (icp_embeddings.ts, score_facts.ts getPitchVector) read this column
-- explicitly; nothing else does.

alter table workspaces
  add column if not exists embedding_cache jsonb not null default '{}'::jsonb;

update workspaces
set embedding_cache = jsonb_strip_nulls(
      jsonb_build_object(
        'icp_embedding_cache',   policy->'icp_embedding_cache',
        'pitch_embedding_cache', policy->'pitch_embedding_cache'
      )
    ),
    policy = (policy - 'icp_embedding_cache' - 'pitch_embedding_cache')
where policy ? 'icp_embedding_cache' or policy ? 'pitch_embedding_cache';
