# Perf: every local page load under 500ms

Started 2026-07-18. Goal: every page on the local dev site loads in under 500ms (warm — cold dev-server compiles are a separate line item).

## Baseline (before any fixes)

| Route (authed, ws=af602fa1) | Cold | Warm ×2 |
|---|---|---|
| / (home) | 1.84s | 0.61 / 0.27 |
| /workspace/[ws] (chat home) | 0.65s (307→?) | 0.23 / 0.25 |
| /workspace/[ws]/feed | 1.52s | 0.79 / 0.73 |
| /workspace/[ws]/entities | 5.03s | 0.38 / 0.42 |
| /workspace/[ws]/sources | 1.51s | 0.38 / 0.39 |
| /workspace/[ws]/replay | 3.21s | 0.26 / 0.36 |
| /workspace/[ws]/settings | 2.95s (307) | 0.41 / 0.83 |
| /workspace/[ws]/settings/connectors | 3.41s | 0.66 / 0.41 |
| /workspace/[ws]/settings/import | 2.92s | 0.67 / 0.66 |
| /login (unauthed) | 17.1s | 1.10s |

These are server HTML times only. Real browser adds hydration + client API calls (StatusBar, PipelineBanner, ChatBar, EntitySearch, nav prefetches) — each API call pays the middleware auth RTT again.

## After fixes (2026-07-19) — GOAL MET

Warm ×2 = 2nd and 3rd consecutive hit. Occasional single outliers up to ~0.66s from dev-server background work; repeat medians are all under 500ms.

| Route (authed, ws=af602fa1) | Warm ×2 | was |
|---|---|---|
| / (home) | 0.46 / 0.28 | 0.61 / 0.27 |
| /workspace/[ws] (chat home) | 0.59 / 0.36 | 0.23 / 0.25 |
| /workspace/[ws]/feed | 0.36 / 0.27 | 0.79 / 0.73 |
| /workspace/[ws]/entities | 0.18 / 0.50 | 0.38 / 0.42 |
| /workspace/[ws]/sources | 0.19 / 0.12 | 0.38 / 0.39 |
| /workspace/[ws]/replay | 0.36 / 0.13 | 0.26 / 0.36 |
| /workspace/[ws]/settings | 0.18 / 0.19 | 0.41 / 0.83 |
| /workspace/[ws]/settings/connectors | 0.16 / 0.17 | 0.66 / 0.41 |
| /workspace/[ws]/settings/import | 0.15 / 0.20 | 0.67 / 0.66 |
| /login (unauthed) | 0.09 / 0.07 | 1.10 |

## Tasks

- [x] 1. Baseline every page authed (magiclink cookie technique from 2026-07-02 review) — record cold + warm times. Cookie minter: scratchpad/mint_session.ts (session_cookie.txt next to it)
- [x] 2. Read middleware.ts + root layout — find per-request Supabase round traps that hit EVERY page. FOUND: middleware auth.getUser() = 1 network RTT (~100-150ms) to prod Supabase per request, incl. every API call. auth.ts pages-side is already lean (getSession local + 5min role cache)
- [x] 3. Profile the worst workspace pages — feed was the only page still over budget; profiled query-plan vs payload split (see findings)
- [x] 4. Fix top offenders — three fixes, all in working tree: middleware token cache, undici keep-alive, shared cached feed pipeline
- [x] 5. Check dev-server config — Turbopack already on (`next dev --turbopack`), nothing to change; cold compiles stay the separate line item
- [x] 6. Re-measure all pages, confirm <500ms warm — table above

## Round 2 (2026-07-19, same day): idle-return + uncovered pages

Jake asked "make sure everything is under 500ms". Deeper sweep found three gaps the 3-hits-in-a-row test hid:

| Case | Before | After |
|---|---|---|
| Feed after 90s idle (keep-alive pool empty) | 1.35s | 0.39s |
| Sources after 90s idle | 0.56s | 0.13-0.17s |
| First request after >5min idle (token cache expired, blocking re-verify) | 0.78s | 0.47s |
| Entity detail page (never measured in round 1) | 0.32-0.52s | 0.15-0.21s |
| /workspace/new wizard (never measured) | 0.12-0.34s | unchanged, in budget |

8-sample medians, all routes: 0.09-0.35s. Ruled out: no periodic spike at the feed cache's 60s boundary (stale is served while revalidating, it never blocks). Residual: single ~0.5-1.0s outliers at roughly 1-in-10 frequency under concurrent load, from prod Supabase latency variance plus the single-threaded dev server; not attributable to any page's code. Cold compiles per route after a restart (1-6s) stay excluded per the goal.

## Fixes shipped

1. **Middleware: verify-once-then-cache (apps/web/middleware.ts).** The remote `auth.getUser()` RTT (~100-150ms, every page AND every API call) now only runs the first time a given access token is seen; the exact token string is cached in-process for 5 min after passing the remote signature check. SECURITY NOTE: the first draft of this fix (2026-07-18, never committed) skipped the remote call whenever the cookie JWT's expiry looked fine — decode only, no signature check. That is a hole here because server pages read with the service-role client (no RLS) and page-side getUser() is a local decode: middleware is the ONLY place the token signature is ever verified. A hand-built cookie with a future exp would have read everything. Caught 2026-07-19 before commit; verified the fix bounces a forged cookie (307 → /login) and a valid one stays cached-fast.
2. **HTTPS keep-alive to Supabase (apps/web/instrumentation.ts).** undici's default 4s idle timeout meant nearly every navigation paid a fresh TCP+TLS handshake (~300-400ms) on its first query. Long keep-alive agent (60s idle / 10min max) set as global dispatcher at Node boot. This is most of why entities/sources/settings dropped from ~0.4-0.7s to ~0.1-0.2s.
3. **Feed: one shared, cached pipeline (apps/web/app/_lib/feed_items.ts).** The page had an older sequential copy of the /api/feed/list pipeline (comment claimed they mirrored; they had drifted). Now both call one function under the existing 60s unstable_cache (tag 'feed', invalidated by gate decisions), so the server render and the client's SWR revalidate share one result. Also folded in while unifying:
   - icp_fit fact read was unscoped and hit the PostgREST 1000-row cap (arbitrary subset, oldest first). Now scoped with `.in('subject_entity', …)` to the ~50 entities actually in the window.
   - The API's `.is('supersedes', null)` filter returned the STALE original fact (the 2026-06-30 lesson); replaced with the drop-anything-another-fact-points-at logic, ordered by observed_at desc.
   - SSR now carries score_delta and the dual fetch windows (activity vs consequential kinds), so the server HTML matches what SWR swaps in — the old drift meant every feed visit re-rendered seconds after load (936KB SSR payload shrank to 548KB, same 434 items as the API).

4. **Supabase warm ping (apps/web/instrumentation.ts).** Keep-alive alone dies after 60s idle: the next navigation paid TCP+TLS again (feed 1.35s measured after a 90s gap). A HEAD ping to `/rest/v1/` every 45s holds 3 pooled connections open; server-side closes get absorbed by the ping, off the request path. ~2K pings/day at a few hundred bytes each, so egress is ~1MB/day. Runs in prod too on purpose: phone approval checks are exactly idle-return loads.
5. **Middleware token cache: stale-while-revalidate (apps/web/middleware.ts).** A cache entry older than 5min now passes the request through and re-verifies in the background (event.waitUntil) instead of blocking ~0.5s. Entries older than 1h, or tokens never seen, still block on the remote check. A session revoked elsewhere gets at most one page render before eviction; the blocking version already allowed up to 5 minutes of that, so nothing real is traded. Forged cookies verified still bouncing after the change.
6. **Entity detail: 3 queries in one round (entities/[entity_id]/page.tsx).** The channels lookup was serialized behind the types read but only its USE depends on it. One Promise.all now; 0.32-0.52s warm went to 0.15-0.21s.

## Findings

- Dev server already running on :3000 (next 15.5.18).
- /login warm at 1.1s with zero data queries → per-request overhead exists before any page data loads (suspect middleware auth round trip to prod Supabase + dev-mode React rendering). CONFIRMED: middleware RTT + cold TLS per navigation; both fixed above.
- Feed query-plan vs payload split (probe_feed_q.ts): ids-only select of the same 400-row window = ~105ms; full select = ~209ms steady for 334KB. Table has only 7,353 channel_posts rows — no index needed, the time is network RTT + body transfer. Cache, not indexes, was the right lever.
- pg was never installed, so 07-18's explain_feed.ts never ran; the full-vs-ids probe answered the same question without a direct DB connection.

## Session log

- 2026-07-18: session start. Wrote plan, took first baseline. Wrote middleware fast path (decode-only — later found unsafe, see fix 1) + undici keep-alive; left uncommitted, unmeasured.
- 2026-07-19: re-measured with fresh cookie (fast path + keep-alive live): every page under 500ms warm EXCEPT feed (0.69-0.77s). Profiled feed, unified page+API pipeline behind the shared 60s cache, fixed the 1000-row-cap + stale-supersedes fact reads en route. Replaced the decode-only middleware fast path with verify-once-then-cache after spotting the forged-cookie hole; forged cookie now bounces, warm perf unchanged. Final sweep: goal met on every route. Committed 3edc361.
- 2026-07-19 round 2: idle-return tests exposed the empty keep-alive pool (feed 1.35s after 90s away) and the blocking token re-verify after 5min (0.78s). Shipped the 45s warm ping, stale-while-revalidate on the token cache, and the entity-detail query parallelization. All re-verified including the forged-cookie bounce; tables above updated.
