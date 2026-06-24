-- 0040: store signal + subscription embeddings as halfvec (2 bytes/dim, was 4).
--
-- Halves both the embedding heap and its HNSW index with negligible recall loss
-- at 1536 dims (each number keeps ~3 significant digits; similarity ranking is
-- unchanged). The model is untouched — this is a storage-precision change only.
--
-- Scope: signals.embedding and the two subscription vectors that it is compared
-- against in match_signal_to_subscriptions (semantic_embedding, learned_centroid).
-- They must convert together because the <=> operator needs both sides the same
-- type. entity_embeddings is NOT touched — it never compares against signals, so
-- the entity query functions (query_facts / query_entities / find_similar_entities)
-- keep working unchanged on vector(1536).
--
-- record_event needs no change: pgvector 0.8 defines vector->halfvec as an
-- IMPLICIT cast, so its existing (p_payload->>'embedding')::vector lands in the
-- halfvec column automatically. Same for the supabase-js writes of learned_centroid.

-- signals.embedding (nullable since 0039; nulls cast to null)
drop index if exists signals_embedding_hnsw;
alter table signals
  alter column embedding type halfvec(1536) using embedding::halfvec(1536);
create index signals_embedding_hnsw on signals using hnsw (embedding halfvec_cosine_ops);

-- subscriptions.semantic_embedding + learned_centroid
drop index if exists subscriptions_embedding_hnsw;
drop index if exists subscriptions_learned_centroid_hnsw;
alter table subscriptions
  alter column semantic_embedding type halfvec(1536) using semantic_embedding::halfvec(1536);
alter table subscriptions
  alter column learned_centroid type halfvec(1536) using learned_centroid::halfvec(1536);
create index subscriptions_embedding_hnsw on subscriptions using hnsw (semantic_embedding halfvec_cosine_ops);
create index subscriptions_learned_centroid_hnsw on subscriptions using hnsw (learned_centroid halfvec_cosine_ops)
  where learned_centroid is not null;
