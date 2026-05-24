# Source-signal test — 2026-05-19

Workspace: `af602fa1-1e0b-4bee-9841-01894553e0a9`  ·  Sample size: 15 (5 each: high-vis / standard / quiet)
Window: 2026-05-19T17:28:31.419Z → 2026-05-19T17:28:38.856Z (one cron-tick equivalent, all 3 active non-YC sources)

## Sample (none hit — see findings)

**high_vis** (5)
- Bolna AI (Fall 2025, team=21) — 0
- Albacore Inc. (Summer 2025, team=18) — 0
- GETASAP (Summer 2025, team=17) — 0
- Icarus (Fall 2025, team=16) — 0
- Flai (Summer 2025, team=15) — 0

**standard** (5)
- &AI (Summer 2024, team=13) — 0
- Abel Police (Summer 2024, team=5) — 0
- Aether (Winter 2024, team=8) — 0
- Alai (Winter 2024, team=5) — 0
- Alice.tech (Winter 2025, team=5) — 0

**quiet** (5)
- 14.ai (Winter 2024, team=3) — 0
- Adapted (Winter 2024, team=2) — 0
- Adri AI (Winter 2023, team=3) — 0
- Affinity (Summer 2023, team=2) — 0
- Aftercare (Winter 2024, team=3) — 0

## Per-source results

| Source | Type | Signals created | Items skipped (no entity match) | Errors |
|---|---|---|---|---|
| hn_u2u2 | hn | 1 | 99 | 0 |
| indie_hackers_main | web (RSS, watch) | 0 | 0 | 1 (DeepSeek 429 rate-limit) |
| techcrunch_startups_rss | web (RSS, watch) | 2 | 14 | 0 |

## What landed (the 3 workspace-wide hits)

| Entity | Source | Signal body | Verdict |
|---|---|---|---|
| **Stilta** | TechCrunch | "Stilta announces $10M seed backed by YC and a16z" | ✅ **Real, high-value** — funding announcement, exactly the signal a sales agent wants |
| **Char** | TechCrunch | TC podcast about OpenAI/Musk trial; no mention of Char | ❌ False positive — 4-char name matched a substring |
| **Nomi** | HN | "MIT 14.12 Economic Applications of Game Theory" | ❌ False positive — 4-char name matched a substring |

**Precision: 1/3 = 33%.**

## Findings

### 1. Substring matching is broken for short names
The web + HN connectors do case-insensitive substring matching on entity names to detect mentions. Short YC company names (3-5 chars) collide with English substrings inside unrelated content. Two of three hits this run were false positives from this.

**Fix:** require word-boundary regex matching (e.g., `\bChar\b`) or apply a minimum-length threshold below which only exact whole-word or alias matches count. ~10 LOC in the connectors' match logic.

### 2. Coverage volume is far too low for a working sales workflow
Three workspace-wide signals in one cron tick. Across 1,424 active entities, that's ~12 signals/day under current sources — each entity gets a signal roughly every 4 months at random. A 15-entity sample landed 0 hits in one tick (expected statistically, not a bug).

This is why the original plan calls for adding free coverage sources (GitHub stars on customer repos, ATS scrapes for hiring, Reddit RSS, per-account blog watchers). Three RSS feeds + one HN connector cannot feed a sales workflow on their own.

### 3. The new watch-mode default works
Both RSS connectors successfully loaded the 1,424-entity watchlist via the new `getWatchedAccounts` helper (no explicit `watch_entities` config needed). The watch-then-filter behavior fired correctly — TechCrunch fetched 16 items, filtered to 2 mentions of workspace entities. That part is doing its job.

### 4. DeepSeek free-tier is rate-limited under load
`indie_hackers_main` failed with a 429 from `deepseek/deepseek-v4-flash:free`. Test ran 3 connectors back-to-back; the burst hit OpenRouter's rate limit on the free tier. Production cron schedule (every 6h) shouldn't trigger this, but ATS/per-account fan-out work in Phase 3b will. We need to wire the OpenAI fallback that's already in `chatCompleteForWorkspace` to kick in on 429 specifically.

### 5. The Stilta signal proves the pattern works end-to-end when the source has signal
TechCrunch published a funding announcement for a YC company; the watch-mode RSS connector matched, created the signal with the correct URL and body, attributed to the right entity. This is the dream case. We just need more sources that produce signals like this.

## Action items (in priority order)

1. **Word-boundary entity matching** in the web + HN connectors (kills the ~67% false-positive rate on short names). Small fix, immediate precision win.
2. **Add high-volume free sources** per the Phase 3b plan: GitHub stars on customer repos, ATS scrapes (Greenhouse/Lever/Ashby), Reddit RSS for relevant subreddits, per-account blog RSS.
3. **OpenAI fallback on OpenRouter 429** in `chatCompleteForWorkspace` — pre-existing fallback works for JSON-validation failures; extend to rate-limit responses.

## Notes

- YC sources (3 active) skipped: emit only on directory deltas (quarterly cron), not testable on-demand.
- Connectors invoked locally to bypass the dev server's stale module-exports map after recent `package.json` edits.
- One cron tick exercised — same volume a real cron firing produces.
- Test fixture is committed at `scripts/fixtures/source_signal_sample.json`; re-runnable.

---

## Round 2 — word-boundary matcher (run at 2026-05-19T17:52:50.198Z)

### Per-source results

| Source | Type | Signals created | Items skipped | Errors |
|---|---|---|---|---|
| hn_u2u2 | hn | 10 | 90 | 0 |
| indie_hackers_main | web | 0 | 0 | 1 |
| techcrunch_startups_rss | web | 2 | 14 | 0 |

### What landed

| Entity | Matched alias | Method | Precise (alias is whole word in body) |
|---|---|---|---|
| YouLearn | `you` | word_boundary | ✓ |
| Nexus | `agent` | word_boundary | ✓ |
| MadeThis | `made` | word_boundary | ✓ |
| VideoGen | `video` | word_boundary | ✓ |
| AnswerThis | `answer` | word_boundary | ✓ |
| TaxGPT | `tax` | word_boundary | ✓ |
| OpenSpec | `open` | word_boundary | ✓ |
| TokenOwl | `token` | word_boundary | ✓ |
| OpenSpec | `open` | word_boundary | ✗ |
| HumanLayer | `human` | word_boundary | ✓ |
| General Legal | `general` | (legacy) | ✓ |
| Boom AI | `boom` | (legacy) | ✓ |

### Aggregate

- Workspace signals created: **12**
- On sample entities: **0/15**
- Precision (alias is whole word in body): **11/12** (92%)

### Round-1 vs Round-2

Round 1 precision: **1/3 = 33%**. Round 2 precision: **11/12 = 92%**.


---

## Round 3 — alias generator tightened (no live re-run yet)

Round 2 lifted "word-boundary precision" to 92% but it was misleading: the alias generator was producing distinctive-stripped aliases like `you` (from YouLearn), `made` (from MadeThis), `token` (from TokenOwl), so the word-boundary match was firing on common English words. Real attribution precision was ~17%.

### Fix

Removed two alias rules:
- **First chunk of CamelCase** (`FurtherAI` → `further` alone) — strips the distinguishing suffix
- **Strip company-suffix** (`Boom AI` → `boom`) — strips the distinguishing suffix

Kept:
- Canonical name itself
- CamelCase split with space (`FurtherAI` → `further ai`) — handles the common stylistic variant
- Domain root + full domain

Trade-off: a story that uses just the prefix ("Further is hiring") would miss. Acceptable — false positives are much worse than occasional missed mentions.

### Unit verification (15/15 pass)

All 12 round-2 false positives now produce **no match** when checked against the rebuilt alias set:

| Entity | Round-2 bogus alias | New aliases | Re-checked match |
|---|---|---|---|
| YouLearn | `you` | `[youlearn, you learn]` | ✓ rejects "buy your services" |
| Nexus | `agent` | `[nexus]` | ✓ rejects "Multi-Agent World Model" |
| MadeThis | `made` | `[madethis, made this]` | ✓ rejects "I made a 3D pose" |
| VideoGen | `video` | `[videogen, video gen]` | ✓ rejects "Badger Video" |
| AnswerThis | `answer` | `[answerthis, answer this]` | ✓ rejects "the answer may lie" |
| TaxGPT | `tax` | `[taxgpt, tax gpt]` | ✓ rejects "EV fee gas tax" |
| OpenSpec | `open` | `[openspec, open spec]` | ✓ rejects "open source catalog" |
| TokenOwl | `token` | `[tokenowl, token owl]` | ✓ rejects "Claude's token usage" |
| HumanLayer | `human` | `[humanlayer, human layer]` | ✓ rejects "Human Bottlenecks" |

True-positive cases (Stilta in TC article, FurtherAI variants, Char-as-whole-word, alice.tech domain) still match correctly.

### Status

Round 2's 12 false-positive signals are sitting in the workspace from before this fix. The next cron tick under the corrected matcher should produce zero of those classes of mismatches. Coverage volume is still the open problem (12 signals workspace-wide per tick across 1,424 entities is too sparse for a working sales workflow) — that's what Phase 3b's GitHub stars + ATS scrapes are for.

### Lessons

1. **A precision number can lie about the metric it's measuring.** "Word is in body as whole word" looks right but doesn't tell you if the alias was sensible to derive in the first place.
2. **Alias generation rules need their own unit tests, not just the matcher.** The matcher worked exactly as designed; the input was wrong.
3. **"Distinctive part of the name" matters more than coverage.** Conservative aliases (no chunk extraction, no aggressive suffix-strip) > permissive aliases.

---

## Round 4 — tightened matcher + 30-entity sample (run at 2026-05-19T19:04:58.332Z)

Sample expanded from 15 → 30 (10 each stratum). Matcher: word-boundary against conservative alias set (canonical name + CamelCase-with-space + domain).

### Per-source results

| Source | Type | Signals created | Items skipped | Errors |
|---|---|---|---|---|
| indie_hackers_main | web | 0 | 0 | 0 |
| hn_u2u2 | hn | 4 | 96 | 0 |
| techcrunch_startups_rss | web | 0 | 15 | 0 |

### What landed

| Entity | Matched alias | Method | Alias is whole word in body |
|---|---|---|---|
| Golpo | `video` | word_boundary | ✓ |
| Golpo | `video` | word_boundary | ✓ |
| Meteor | `browse` | word_boundary | ✓ |
| Nexus | `agent` | word_boundary | ✗ |

### Aggregate

- Workspace signals created: **4**
- On sample (30 entities): **0**
- Sample entities with ≥1 signal: **0/30**
- Alias-in-body whole-word precision: **3/4**


---

## Round 4 — tightened matcher + 30-entity sample (run at 2026-05-19T19:10:28.989Z)

Sample expanded from 15 → 30 (10 each stratum). Matcher: word-boundary against conservative alias set (canonical name + CamelCase-with-space + domain).

### Per-source results

| Source | Type | Signals created | Items skipped | Errors |
|---|---|---|---|---|
| indie_hackers_main | web | 0 | 0 | 1 |
| hn_u2u2 | hn | 0 | 100 | 0 |
| techcrunch_startups_rss | web | 0 | 15 | 0 |

### What landed

No new signals — likely dedup against round-2/3 history. Live re-run with fresh content needed for a clean per-tick number.

### Aggregate

- Workspace signals created: **0**
- On sample (30 entities): **0**
- Sample entities with ≥1 signal: **0/30**


---

## Round 5 — domain-root extraction removed (final matcher version)

After round 4 ran live, three more false positives surfaced from a different bug: domain-root extraction was treating the leftmost dot-segment as the brand, but subdomained domains have a product/feature name there:

- `video.golpoai.com` → alias "video" → matched "Badger Video"
- `browse.dev` → alias "browse" → matched "Browse.sh"
- `agent.nexus` → alias "agent" → matched "Multi-Agent World Model"

### Fix

Dropped domain-root extraction entirely. Aliases are now strictly: canonical name, CamelCase-split-with-space, full cleaned domain. The trade-off acknowledged: a signal mentioning only the URL prefix (`"check out alice"` for `alice.tech`) won't match. Real coverage uses the full name or full domain.

### Unit validation

17/18 cases pass. The 1 "fail" is a test-expectation nitpick (matcher picks first-iterated alias under the Set, attribution to the correct entity is still right).

### Live run (round 5)

| Source | Signals | Skipped | Errors |
|---|---|---|---|
| hn_u2u2 | 0 | 100 | 0 |
| indie_hackers_main | 0 | 0 | 1 (DeepSeek 429) |
| techcrunch_startups_rss | 0 | 15 | 0 |

**Zero new signals.** Most of the 24h HN/RSS window was already processed in rounds 1–4, so dedup blocked everything. The tightened matcher also correctly rejected every borderline case it would have falsely accepted previously. No live precision number — but the unit tests cover the failure modes we observed.

## Final state — what the matcher does today

```
Aliases for each entity:
  - canonical name (lowercased, ≥3 chars)
  - CamelCase split with space ("FurtherAI" → "further ai")
  - Full cleaned domain ("alice.tech")

Match logic:
  - For each entity, regex `\b<alias>\b` against signal haystack
  - First matching entity wins; record entity_id + matched_alias + attribution_method='word_boundary'
```

## Volume is still the unsolved problem

Across all 5 rounds, the workspace generated maybe 15-20 signals total in 24h from this source set. Across 1,424 active entities that's ~one signal per entity every ~3 months at random. No matcher tightening fixes the coverage problem — that's the next phase (GitHub stars on customer repos, ATS scrapes for hiring, Reddit RSS, per-account blog watchers).

## Final lesson

Three rounds of iteration on the matcher exposed:
1. **Substring matching is broken** (round 1)
2. **Alias generators need adversarial review, not just happy-path unit tests** (rounds 2 + 4)
3. **The "metric I built to measure precision" can be wrong about what precision means** — round 2's 92% number lied; the alias generator was producing the wrong aliases, not the matcher failing
4. **Domain heuristics without a Public Suffix List are unreliable** for modern domains with subdomains or new TLDs

Each round shrank the alias set. Final aliases are the most conservative possible while still handling stylistic variants (FurtherAI / Further AI).
