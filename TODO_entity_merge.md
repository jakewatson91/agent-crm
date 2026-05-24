# TODO: Merge `channels` into `entities`

**Status:** deferred. The UI/URL rename (channel → entity) is shipped; the schema collapse is not.

## Why

`channels` is 1:1 with account-kind `entities` (unique constraint on `(workspace_id, account_entity_id)`). The only data it carries is `title` + its own `id`. Every join is `channels.account_entity_id = entities.id`. The table is conceptual scaffolding, not a real entity in the model.

Leaving it means every contributor has to learn: "a channel is just an entity, but it has its own id, but only for accounts, and the entity page URL uses entity_id but the data layer still pivots through channels." That's permanent cognitive overhead for zero substrate benefit.

## What to do

1. **Migration**
   - Add `title text` to `entities` (nullable; backfill from `channels.title` for account-kind rows).
   - Rename `channel_posts` → `entity_posts`. Replace `channel_id uuid references channels(id)` with `entity_id uuid references entities(id) on delete cascade`. Backfill via `channels.account_entity_id`.
   - Drop the `channels` table.
   - Update `target_kind` enum: remove `'channel'` and `'channel_post'`, add `'entity_post'`. (Or keep both during transition and clean up later.)
   - Update any triggers / fns that reference `channels` or `channel_posts` — at minimum `record_event`, `replay_active_facts`, anything in `0002_triggers.sql` / `0004_replay_fn.sql` / `0005_query_fns.sql`.

2. **Server / API**
   - `apps/web/app/api/channels/[channel]/timeline/route.ts` → `apps/web/app/api/entities/[entity_id]/timeline/route.ts`. Drop the channel lookup step in `EntityPage`; the URL param is the query param now.
   - Same for `/api/channels/[channel]/summary/route.ts`.
   - `apps/web/app/api/agent/intake/tools.ts` line 251 (`from('channels')...`): the intake agent's lookups go straight to entities. The `account_entity_id` indirection disappears.
   - `apps/web/app/api/gates/list/route.ts` line 31: same.
   - `apps/web/app/api/admin/health/route.ts`: same.
   - `apps/web/app/api/admin/routing-preview/route.ts` line 115: same.
   - `apps/web/app/api/entities/lookup/route.ts`: drop the channels join — `channel_id` becomes `entity_id` (always present for accounts).

3. **Client**
   - `EntityDetail.tsx`: takes `entityId` instead of `channelId`.
   - `FeedStream.tsx`: already links to `/entities/${entity_id}`; drop the `channel_id` / `channel_title` fields from the `FeedItem` type.
   - `feed/page.tsx`: query `entity_posts` directly, drop the `channels!inner(...)` join.

4. **Types**
   - `packages/tools/src/schemas.ts` — search for `channel`, replace.
   - Any `ChannelPost` / `Channel` types — rename to `EntityPost` / drop.

## Scope estimate

~25 files. One migration. Plan a half-day, dev server stopped, on a feature branch. No customer impact (dogfood-only as of 2026-05-17).

## Open question before starting

Do non-account entities (contacts, products) ever get their own activity page? Today no — only accounts have channels. If the answer changes to yes, the merge still works: `title` and `entity_posts` apply to any entity kind, the schema just gets used more broadly. So don't let this question block the merge.
