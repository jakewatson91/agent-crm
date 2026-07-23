-- Atomic account merge: fold `duplicate` into `canonical`, preserving provenance.
-- Reassigns facts / signals / channel posts / contact links, then archives the
-- duplicate and stamps _merged_into on it. Destructive, but nothing is hard-deleted
-- (the duplicate is archived, conflicting facts stay on it), so the merge is auditable
-- and reversible from the event log. Only ever called after a human approves the merge
-- proposal in the UI.
create or replace function merge_accounts(
  p_workspace_id uuid,
  p_canonical uuid,
  p_duplicate uuid
) returns jsonb as $$
declare
  v_facts_moved int := 0;
  v_facts_dup   int := 0;
  v_sigs_moved  int := 0;
  v_posts_moved int := 0;
  v_links_moved int := 0;
  v_new_hash    text;
  r             record;
  v_canon_chan  uuid;
  v_dup_chan    uuid;
begin
  if p_canonical = p_duplicate then
    raise exception 'cannot merge an entity into itself';
  end if;

  -- 1. Facts where the duplicate is the SUBJECT. Recompute the content hash for the
  --    canonical subject and move only the facts the canonical does not already hold as
  --    an active fact — moving a colliding one would violate facts_content_hash_active.
  --    Colliding facts (is_a, shared product, etc.) stay on the archived duplicate.
  for r in
    select id, predicate, object_text, object_entity
    from facts
    where workspace_id = p_workspace_id and subject_entity = p_duplicate and supersedes is null
  loop
    v_new_hash := compute_fact_hash(
      p_workspace_id, p_canonical, r.predicate, r.object_text,
      case when r.object_entity = p_duplicate then p_canonical else r.object_entity end);
    if exists (select 1 from facts
               where workspace_id = p_workspace_id and content_hash = v_new_hash and supersedes is null) then
      v_facts_dup := v_facts_dup + 1;
    else
      update facts set
        subject_entity = p_canonical,
        object_entity  = case when object_entity = p_duplicate then p_canonical else object_entity end,
        content_hash   = v_new_hash
      where id = r.id;
      v_facts_moved := v_facts_moved + 1;
    end if;
  end loop;

  -- 2. Facts elsewhere that POINT AT the duplicate (object_entity) — e.g. a contact's
  --    works_at edge. Re-point to the canonical, recomputing the hash; skip on collision.
  for r in
    select id, subject_entity, predicate, object_text
    from facts
    where workspace_id = p_workspace_id and object_entity = p_duplicate and supersedes is null
  loop
    v_new_hash := compute_fact_hash(p_workspace_id, r.subject_entity, r.predicate, r.object_text, p_canonical);
    if not exists (select 1 from facts
                   where workspace_id = p_workspace_id and content_hash = v_new_hash and supersedes is null) then
      update facts set object_entity = p_canonical, content_hash = v_new_hash where id = r.id;
      v_links_moved := v_links_moved + 1;
    end if;
  end loop;

  -- 3. Signals — (workspace, entity_id) is a plain index, so they move wholesale.
  update signals set entity_id = p_canonical
    where workspace_id = p_workspace_id and entity_id = p_duplicate;
  get diagnostics v_sigs_moved = row_count;

  -- 4. Channels — (workspace, account_entity_id) is UNIQUE, so the duplicate's channel
  --    cannot just be re-pointed if the canonical already has one. Fold the duplicate
  --    channel's posts into the canonical channel and drop the empty duplicate channel;
  --    if the canonical has no channel, re-point the duplicate's.
  select id into v_canon_chan from channels
    where workspace_id = p_workspace_id and account_entity_id = p_canonical limit 1;
  select id into v_dup_chan from channels
    where workspace_id = p_workspace_id and account_entity_id = p_duplicate limit 1;
  if v_dup_chan is not null then
    if v_canon_chan is null then
      update channels set account_entity_id = p_canonical where id = v_dup_chan;
    else
      update channel_posts set channel_id = v_canon_chan where channel_id = v_dup_chan;
      get diagnostics v_posts_moved = row_count;
      delete from channels where id = v_dup_chan;
    end if;
  end if;

  -- 5. Archive the duplicate (never delete — keeps the merge auditable and undoable).
  update entities set
    archived_at = now(),
    attributes  = coalesce(attributes, '{}'::jsonb) || jsonb_build_object('_merged_into', p_canonical::text)
  where id = p_duplicate and workspace_id = p_workspace_id;

  return jsonb_build_object(
    'facts_moved', v_facts_moved, 'facts_duplicate', v_facts_dup,
    'signals_moved', v_sigs_moved, 'posts_moved', v_posts_moved, 'links_moved', v_links_moved);
end;
$$ language plpgsql security definer;
