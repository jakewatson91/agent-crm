-- One-time cleanup: archive existing connector-junk entities.
--
-- Mirrors the shape rules in inngest/.../utils.ts:validateCompanyName and
-- apps/web/.../entities/page.tsx:isJunkName. Vertical-specific brand names
-- (the publication blocklist) live in `workspaces.policy.publication_blocklist`
-- and are pulled in via the join below. DO NOT inline brand names here.
--
-- Safe: sets archived_at, does not delete. Restore with
--   update entities set archived_at = null where ...;
-- if you flag any false positives.
--
-- Preview first by running the SELECT, then run the UPDATE.

with workspace_blocklist as (
  select id as workspace_id,
         coalesce(
           (policy->'publication_blocklist'),
           '[]'::jsonb
         ) as blocklist
  from workspaces
),
candidates as (
  select e.id, e.workspace_id, e.name, e.kind, e.attributes->>'domain' as domain
  from entities e
  join workspace_blocklist w on w.workspace_id = e.workspace_id
  where e.archived_at is null
    and (
      -- Synthetic fallback domain from connector
      (e.attributes->>'domain') like '%.example'
      -- Single-token all-lowercase handle
      or (e.name ~ '^[a-z0-9]+$' and length(e.name) > 3)
      -- Multi-word all-lowercase buzzword phrase
      or (e.name ~ '\s' and e.name = lower(e.name))
      -- Cram-job: single-token, 2+ leading caps + lowercase
      or (e.name !~ '\s' and e.name ~ '^[A-Z]{2,}[a-z]')
      -- Single-token > 14 chars
      or (e.name !~ '\s' and length(e.name) > 14)
      -- 5+ word names (article titles)
      or (array_length(string_to_array(e.name, ' '), 1) >= 5)
      -- Article-suffix endings
      or (e.name ~* '\s(story|guide|tips|trends|outlooks?|insights|review|reviews|news)$')
      -- Listicle starter + 4+ words
      or (e.name ~* '^(best|top|how to|why|what is|guide to|the ultimate|the best|the top)\s'
          and array_length(string_to_array(e.name, ' '), 1) >= 4)
      -- Workspace-specific publication blocklist (case-insensitive exact match)
      or exists (
        select 1 from jsonb_array_elements_text(w.blocklist) as b(name)
        where lower(e.name) = lower(b.name)
      )
    )
)
-- Preview:
-- select * from candidates order by workspace_id, name;

-- Apply:
update entities
set archived_at = now()
where id in (select id from candidates);
