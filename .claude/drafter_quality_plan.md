# Drafter quality: what's done, what's left

Started from one bad LinkedIn draft. The writing turned out to be the last problem in the
chain, not the first. This is the running plan. Item 1 is shipped; items 2 to 6 are not.

## The draft that started it

> CHZZK on TVU One at 100K concurrent viewers, does your cloud egress per view fall, or grow
> 1:1 with audience? Delivery usually scales 1:1, the repeat share is a cost most can't see.
> We built a script that offloads it between viewers, no source change. Want me to put your
> numbers to it? Offload % shows in your cloud dashboard.

Written to **TVU Networks**, entity `39f75923-e46e-48aa-9524-f009c6be6c70`, on 2026-07-31.

What was actually wrong, worst first:

1. TVU sells live video production gear and cloud production to broadcasters. They don't pay
   a viewer delivery bill, their customers do. Nothing to reduce.
2. Everything about them is live. Live is out of scope: the product serves web HLS video on
   demand and replay catalogs.
3. CHZZK is TVU's **customer**, not the prospect. The message opened with a stat about the
   prospect's own customer, then asked "does *your* egress fall" about traffic that isn't theirs.
4. The account had an open advisor conversation (`prospect_notes`: "he's interested in advisor
   role... Need to follow up"). A cold pitch landed on top of it.
5. Only then: the writing. Five of six beats were template `t3_technical` with synonyms swapped.

It scored `icp_fit 0.87`, `industry_match 1.00`. The scorer read "media technology company"
and matched on industry. Nothing in the system could express "they sell what we sell" or
"their traffic is the kind we can't serve."

## Item 1 — enforce what we can serve. DONE

New config `policy.drafter.out_of_scope`: a list of plain sentences describing accounts that
can't be served, whatever their fit score. Empty by default, so no other workspace changes
behavior. Read in two places.

**Scorer** (`packages/tools/src/scoring.ts`) — a veto, not a weighted dimension. A matched
condition forces `icp_total` to 0 and `action_selector` then routes to `drop`.

Why a veto: `scripts/check_out_of_scope.ts` runs TVU's real sub-scores through
`combineSubScores`. As scored it lands at 0.78. Zeroing an entire dimension outright, the most
generous version of "average a disqualifier in", still lands at 0.71. The draft bar is 0.40.
No weighting could ever have stopped this. Only forcing the total to 0 does.

**Drafter** (`packages/tools/src/prompt_builders.ts`) — STEP 0, before every other step,
returning `request_gate` with policy `account_out_of_scope`. This is the one that covers the
backlog: an account scored before a condition existed keeps its standing score, and the
drafter refuses at write time anyway.

Guards, all asserted in `scripts/check_out_of_scope.ts` (wired into `pnpm check`):

- The model returns a 1-based condition **number**. An index outside the configured list is
  dropped, not applied, so an invented condition can't delete a real prospect.
- Zero, negative and fractional indices are dropped.
- Evidence is truncated to 200 chars.
- Both prompts say fire only on a fact that shows it, never on an assumption about what a
  company with that name probably does, and that missing information is not evidence.
- A stored veto survives the score-reuse path. Without that, the recombine would hand back a
  passing total from sub-scores already judged unserviceable.

`out_of_scope` is deliberately **not** in `scoreInputsHash`. Hashing it would re-run the rubric
across all ~1961 Sudden accounts the moment a condition is added or edited. Same reasoning the
existing comment gives for keeping weights out. The drafter stop covers the gap.

### Verified, not assumed

| Check | Result |
|---|---|
| `pnpm verify` | passes, new suite included |
| TVU through the live drafter prompt | `request_gate` / `account_out_of_scope`, citing "TVU One Backpack, cloud production systems" from its own facts |
| SOOP through the same prompt | drafts normally, and targets the replay catalog: "how much egress is repeat highlights and replays" |

The SOOP result is the one that matters most. SOOP is a live-streaming company that is *in*
scope because of its web replay catalog, and condition 1 correctly does not fire. The veto
discriminates rather than blanket-killing anything with "live" in its facts.

### Files

- `packages/tools/src/policy.ts` — `DrafterPolicy.out_of_scope`
- `packages/tools/src/scoring.ts` — `resolveOutOfScope()`, `ScoreBreakdown.out_of_scope`, rubric block, veto, reuse-path guard
- `packages/tools/src/prompt_builders.ts` — STEP 0
- `inngest/functions/agent_logic.ts` — field threaded through `ExplicitDrafterPrompt`
- `scripts/check_out_of_scope.ts` — assertions, wired into `pnpm check`
- `scripts/_set_sudden_out_of_scope.ts` — Sudden's three conditions (config, re-runnable)
- `scripts/_dryrun_account.ts` — read-only single-account drafter run: `tsx scripts/_dryrun_account.ts SOOP`
- `scripts/_dryrun_drafts.ts` — now passes `out_of_scope`, so the grader tests shipping behavior

### Sudden's two conditions

1. Live only, no VOD or replay catalog on the web.
2. Sells video infrastructure or delivery to streaming companies instead of operating one.

Both come from evidence already in the workspace: SOOP's `company_description` fact ("Live is
out of scope; the addressable surface is the VOD/replay catalog on web"), template `t3`'s notes
("web HLS VOD today, native on roadmap"), and the ICP wording "running their own streaming
platform".

A third condition was written and then dropped before the rescore: *reaches viewers only
through native or TV apps, no web player*. Almost every streaming company has a web player, so
the binary test never fires, and the accounts it was aimed at (vertical drama apps, where most
viewing really is in-app) have web players too and slip straight through. The real question is
what SHARE of viewing happens on web, which research should size, not a veto. Don't re-add it
in this shape.

### The rescore, and what it actually showed

`out_of_scope` IS in `scoreInputsHash` (revised from the first pass). Editing a condition
changes the verdict, not just the ranking, so a stored judgment made under the old list has to
be re-run — the same bargain an `icp` or `about` edit already makes. The cost is a full
re-rubric of the book per condition edit. Budget for it before touching the wording.

**Trap worth knowing: the hash is not enough on its own.** `scoreEntity`'s skip-when-stale
guard returns null BEFORE the hash is ever compared, whenever no substantive fact is newer than
the last score. The only thing that gets an unchanged account past it is
`policy.scoring_config_state.changed_at` being newer than the score. The first rescore attempt
here no-opped on roughly three quarters of the accounts for exactly this reason (a run of `-`
marks in `rescore_all.ts` output means skipped, not scored).

So **any write to a scoring input must bump `scoring_config_state.changed_at`**.
`_set_sudden_out_of_scope.ts` now does. Anything else that edits `out_of_scope` — a settings UI,
a wizard step, another script — has to do the same or the change silently never applies. That
is a sharp edge worth designing out: the bump belongs in whatever function writes the config,
not in each caller.

Sample of the top 25 before the full run: **zero vetoed**, correctly. The top of the book is
real VOD operators (WATCH IT!, Weyyak, TVing, RTVE, France TV, ViX, OSN+). The veto is not
trigger-happy.

But every score fell, and that is NOT the veto. Attribution from `_chk_score_delta.ts`:

- **MBC Group**: all three LLM dimensions identical, `recency` 1.00 → 0.06. That is the
  published-date fix from the 2026-07-31 session landing. Recency used to read our own write
  time; it now reads real source dates, and 0.06 means the newest dated fact is ~126 days old,
  not the ~6 days the old number implied. `graph_proximity` also became measurable and left
  `unknown_dims`.
- **Pocket FM** 0.93 → 0.64: a real re-judgment. signal_strength 1.00 → 0.00 because the newest
  facts are the discontinuation of its Pocket TV video vertical, and industry_match 1.00 → 0.70
  because it is an audio platform. Both correct.

So the book-wide drop is accumulated prior fixes becoming visible, and the old numbers were
inflated. Anyone reading score history across 2026-08-04 needs to know that before concluding
the scorer got stricter.

---

### Rescore RESULT (completed 2026-08-04)

1961 accounts. **18 of 2163 current breakdowns vetoed, 0.8%.** No false positives found on
inspection — the full vetoed list:

- Vendors: AWS, Akamai, Level3, Edgio, CDN77, JW Player, Kaltura, Wowza, muvi, VPlayed,
  The NineHertz, Caylent, Intel, TVU Networks, **Netskrt Systems** (peer-assisted delivery, a
  direct competitor)
- Live-only: Willow (cricket), More Than Sports TV, Walta Info

Condition 2 (vendor, not operator) does almost all the work; condition 1 (live only) caught
three. The veto is conservative, which is the correct bias for something that removes accounts
from the book.

### Verifying a future rescore (do this before trusting a new condition)

Started 2026-08-04, ~1961 accounts, ~2 hours at concurrency 8. Finishing the run is not the
same as checking it. The failure mode that matters is a false positive: the veto is the one
path that removes a prospect from the book entirely, so a condition that over-fires is worse
than the bug it fixed.

What to check, in order:

1. **How many were vetoed.** Query `icp_fit_breakdown` facts for a non-empty `out_of_scope`.
   A handful is expected. Hundreds means a condition is too broad — most likely condition 1
   firing on any account with "live" anywhere in its facts, which is exactly what the SOOP
   test was built to catch.
2. **Read ten vetoed accounts against their facts.** Each veto string carries the condition and
   the quoted evidence. The evidence has to actually show the condition, not merely mention
   live streaming or infrastructure. `scripts/_dryrun_account.ts <name>` re-runs the drafter on
   any one of them.
3. **Check the survivors that should have been caught.** Anything in the book that is a pure
   live operator or a delivery vendor and did NOT get vetoed is a false negative. Cheaper to
   live with than a false positive, but it tells you the conditions need sharpening.
4. Only then treat `icp_fit` as trustworthy again.

If a condition over-fires: edit the wording in `_set_sudden_out_of_scope.ts`, re-run it (it
bumps `changed_at` itself now), and rescore again. Each edit costs a full re-rubric, so get the
wording right on paper first.

## Item 2 — vendor vs operator, as a fact rather than a condition

Condition 2 catches vendors at scoring and draft time, but every account pays an LLM call to
re-derive something that never changes. A company either operates a streaming service or sells
to people who do, and that's stable.

Make the enricher assert it once, then let scoring read it. Something like
`business_model :: operates_streaming_service | sells_to_streaming_services | neither`.
Cheaper, auditable, and it makes "show me every vendor in the book" a query instead of a
2000-call sweep.

Open question: does this generalize, or is it Sudden-specific? A vertical-neutral version is
closer to "does this account buy this category or sell it", which is worth having everywhere.
Keep the predicate name in config if it stays vertical-shaped.

## Item 3 — an existing relationship should suppress cold outreach

TVU had `prospect_notes` describing an advisor conversation with Jonathan Solomon and still
got a cold first-touch DM. Nothing reads relationship state before drafting.

Cheapest version: a lifecycle check in `action_selector.ts` before `draft_outreach`. If the
account carries a note or fact indicating a live human relationship, route to a gate instead
of drafting. Needs a decision on what marks that state, since `prospect_notes` is free text and
not reliable to parse.

Related: TVU's `company_description` is a **person's** LinkedIn bio ("Ex-AWS, Principal Partner
Solutions Architect"), not the company's. Contact facts are leaking onto account entities.
Worth a sweep to find how widespread that is before trusting `company_description` anywhere.

## Item 4 — stop dropping config the drafter already computes. DONE

`deriveDefaults(ABOUT)` computes `pain_points` and `value_props` at workspace creation. They're
stored, passed into `buildSystemPrompt`, threaded into `buildDrafterDecision` — and the
templates branch returns before ever rendering them. Computed, stored, passed, thrown away.

Sudden's four `pain_points` include *"Delivery is the dominant line on the infrastructure bill
and spikes on every release"*, which is a genuinely different angle from the two the templates
carry, and the drafter has never once seen it.

Rendered in the templates branch as a content menu placed AFTER the exemplars, so it is the
last content the model reads before the output instruction. Two headings: "PROBLEMS WE SOLVE"
(pick one, build the Think question from it) and "WHAT IT ACTUALLY DOES" (true behaviors you
may state). Both say the exemplar's wording is one option, not the required one, and neither is
a credibility claim — the constitution still governs what may be asserted.

`scripts/_chk_drafter_prompt.ts` asserts the sections actually render, so a field that silently
stops appearing is caught by running a script rather than by reading a bad draft weeks later.

## Item 5 — why every draft is the same pitch. PARTLY DONE

`prompt_builders.ts` STEP 3 no longer teaches the 1:1 fork. It now gives two structurally
different forks, both vertical-neutral, and says explicitly that they are shapes rather than
scripts and that a fork already seen in an exemplar is the one to avoid.

Also removed from the same step: `"When you drop a new series, how much egress is the same
segments over and over?"`. That was Sudden's vertical baked into shared craft code whose own
header comment says it is "the same for every workspace and every vertical". `grep -n
"1:1\|egress\|segments\|CDN" packages/tools/src/prompt_builders.ts` now returns nothing; keep it
that way.

### What it changed, measured

SOOP, before (same account, same day, menu absent):

> Hanjo, you've got LCK, ASL, and Gen.G's Korean roster exclusive on SOOP — the replay catalog
> is the year-round fan hub. As VOD traffic scales, how much egress is repeat highlights and
> replays? ...

SOOP, after:

> Hanjo, network usage cost at SOOP rose 26% last quarter to 6.2B KRW, even while traffic
> declined. How much of that egress is the same VODs and replays served repeatedly? ...

The trigger moved from a generic scaling premise to their own reported cost line, and "even
while traffic declined" is the kind of observation that reads as someone who actually looked.
No 1:1.

### The exemplar rewrite. DONE

`scripts/_set_sudden_exemplars.ts` rewrote all three template bodies into middle-mile freight,
keeping each template's shape, sentence count and beat order. `audience` is untouched, since it
drives selection. `notes` and `follow_up` are reference-only and were left alone. Config only,
no code, no rescore.

MBC Group, the account that produced the clone, re-drafted immediately after:

> Hey Dominic, MBC's betting big on Shahid: revenue SAR 1.38B last year, SVOD subs up 25%.
> Growth like that usually means delivery costs climb alongside. Are your CDN costs per stream
> holding steady, or starting to tick up as your audience and library expand?

No 1:1, no exemplar phrasing, subject and verb in the opener, complete closing sentence.

### What the 8-account run then showed

Copying stopped. Convergence did not. Three of four drafts still built on the cost-scales-with-
audience angle, and the source is now identifiable: it is `pain_points[0]`, the first item in the
menu, plus the constitution naming it as one of only two allowed claims.

**The distinction that matters: the CRED repeating is correct and intended. The QUESTION
repeating is the defect.** Compare two drafts from the same run, both using the same approved
1:1 cred:

> Intigral: "You consolidated players across devices with Bitmovin to cut costs. Did that reduce
> delivery cost, or does egress still just scale with every new viewer?"

> Kuku: "The Night CEO hit 1M views in six days... Is your cost-per-view declining, or still
> running 1:1?"

Intigral's question cannot be asked of any other company. Kuku's could be pasted anywhere. Both
passed every mechanical check. Roughly 2 of 4 now clear this bar, up from 0 at the start.

### The angle-justification change: better drafts, fewer of them

The drafter must now name which menu problem it built the question on AND why the others fit
this account less well. Re-ran the same six accounts before and after, so this is a clean
comparison rather than two different samples.

**Before:** 4 gated, 2 drafted. **After:** 5 gated, 1 drafted.

The surviving draft got better. idilio TV, same account, before and after:

> Before: "Idilio's scaling fast—1M+ downloads, $5.5M raised... As the platform grows, does
> delivery cost per viewer climb right along with it? For most streaming services, delivery cost
> grows one-to-one with audience."

> After: "Hey Esteban, you've made production 40x cheaper and 30x faster, already past 1M
> downloads. Delivery cost usually scales with the audience. Do you see how much egress is just
> repeat views, or is it still a single number in the CDN bill?"

It moved off the 1:1 angle onto the visibility angle (`pain_points[1]`), which had never been
picked before, and "or is it still a single number in the CDN bill" is the kind of framing that
sounds like someone who has seen a CDN bill. It also uses the pattern-then-question order that
is now explicitly allowed.

**The cost: Intigral flipped from the best draft of the session to a gate.** It previously
opened "You consolidated players across devices with Bitmovin to cut costs. Did that reduce
delivery cost, or does egress still just scale?" Now it refuses, because the Bitmovin fact is
undated and STEP 1 forbids anchoring mode A on an undated fact.

That gate is defensible under the rules as written, but losing the single most specific message
in the whole session to a date-strictness rule is a real trade. **This is a decision for Jake,
not a bug:** either loosen mode B so a strong undated fact plus supporting dated ones can carry
a theme, or accept a higher gate rate and fix it on the research side by getting published dates
onto those facts. The second is the better fix and is item 1 of the signal-extraction list.

Sample is six accounts. Treat the direction as real and the magnitude as noisy.

### Item 5's remaining half — BUILT 2026-08-04, uncommitted. The sameness moved, it did not go.

The angle is now picked before the prompt renders an exemplar, and any exemplar arguing that
same point renders its anatomy with the body cut. Verified end to end. What the measurement
then showed is that the templates were not the last cause of sameness, only the one we could
see: **five of seven accounts get assigned the same problem, and that problem is written as the
question**, so the drafts still rhyme. Details below, then what is left.

**What ships (all uncommitted, dev only — the automated drafter keeps the old behaviour until
this is committed and Render redeploys):**

- `policy.drafter.templates[].angle` — one plain sentence naming what that exemplar argues.
  Config, per workspace. Unset = the exemplar always renders in full, which is the old
  behaviour, so this cannot break a workspace that never sets it.
- `packages/tools/src/pick_angle.ts` — one cheap-model call per drafted account
  (`deepseek-v4-flash`, the same model `classifyRole` uses; the drafter itself stays on
  `deepseek-v4-pro`). It reads the account's facts, picks one problem from `pain_points`, and
  names which template angles argue that same thing.
- The prompt then renders `THE PROBLEM YOU ARE WRITING TO` in place of the four-item menu, and
  the colliding templates render `EXEMPLAR: WITHHELD` plus their anatomy.
- Failure is a no-op by design: any error, any unparseable answer, or "no problem fits" falls
  back to the exact prompt that rendered before. The picker cannot block a draft.
- `AngleDecision` carries a reason (`llm_error` / `unparseable` / `no_problem_fits` /
  `no_facts` / `menu_too_small`) instead of a bare null, and the reason lands on the
  `drafter_shortlist_pick` event next to the draft it shaped. A silent null here would be the
  same trap as the harness that reported "0 contacts" for every account.
- `scripts/_set_sudden_template_angles.ts` tags Sudden's four templates. Already applied.

**A real bug this surfaced, now structurally fixed.** `angle` was passed into
`buildSystemPrompt` correctly and never reached the prompt: the hand-off to
`buildDrafterDecision` re-lists every key by hand, and the new one was not in the list. That is
the THIRD field this call site has eaten (`templates` in `f101935`, `char_budget` caught
pre-commit on 07-21). Every field is optional on the receiving type, so a dropped key
type-checks clean. It now spreads the object instead of re-listing keys, so there is nothing
left to forget. `_chk_drafter_prompt.ts` is what caught it, within a minute of the change.

**Measured, two runs of the top 8 (`_dryrun_drafts.ts 8`):**

| | first run | after tightening the picker |
|---|---|---|
| distinct problems chosen | 2 | 3 |
| accounts on the most common problem | 5 of 6 | 5 of 7 |
| draft pairs over 45% word overlap | 3 | 1 |

Withholding works: MBC Group now picks the cost-per-viewer problem and `t2_founder` — the exact
template it cloned on 2026-08-04 — renders with no body. Ab Films TV picked the redundant-egress
problem and withheld `t3_technical` instead. Cineverse got the release-spike problem, withheld
nothing, and produced the one genuinely different question in the batch: whether the CDN
delivery during a popular episode is redundant.

**What is left, and it is now a config question, not a code one.** Sudden's `pain_points[0]` is
*"Delivery cost per viewer never falls; the cost line grows one to one with the audience"* —
which is not a problem so much as the answer to the question every draft asks. Problems 2 and 4
(redundant egress; delivery spikes on every release) are both special cases of it. The picker
cannot separate what the config does not separate, so it keeps landing on the general one, and
once assigned it, the drafter writes the 1:1 question with no exemplar to copy from. Two moves,
both Jake's:

1. Rewrite the menu so the four entries are genuinely different problems rather than one
   problem at four zoom levels. This is the higher-yield one.
2. Accept some convergence as mandated: the constitution allows exactly two credibility claims
   and one of them IS the 1:1 claim. That was a deliberate choice and this does not change it.

### The menu rewrite. DONE 2026-08-04, and it turned on one product fact

Jake: **offload needs viewers watching the same title at the same time**, and the product is
aimed at back catalogue, not live. That answer killed half of what was drafted for this menu and
is worth writing down, because the same wrong ideas will look attractive again later:

- **Anything about a premiere, a live match or a launch peak is out**, and not only because the
  product targets catalogue. `out_of_scope` condition 1 already vetoes live-only accounts, so a
  pain point about live events would have aimed the drafter at the exact accounts the veto
  exists to exclude. A menu entry and a veto pointing opposite directions is worse than either.
- **Binge viewing and long-tail library rewatch are out** for the mechanism reason: both are
  viewing spread over time, and spread-out viewing forms no swarm.
- **A minimum-concurrency floor exists and its value is unknown.** Do NOT make it a fourth
  `out_of_scope` condition — that is the same shape as the web-share condition deleted this
  morning, a binary test that cannot fire because peak concurrency is not a fact the book holds
  for most accounts. It belongs as a research question first, so the number gets collected, and
  a scoring input once there is coverage. **BUILT:** `research.always_include` now carries
  "peak concurrent viewers or simultaneous streams on a single title", and the planner has
  authored an angle for it — `open_peak_viewers`, open_web, 365-day window (a concurrency record
  does not go stale in 30 days). Revisit the floor once there is coverage to look at.

  **A gap found doing it, worth knowing before editing any research config:** `isStrategyFresh()`
  checks only the AGE of `strategy_generated_at`. The docstring says the strategy regenerates on
  a guidance change, but nothing in the code watches `guidance` or `always_include`, so a config
  edit sits inert until the cached strategy ages out on its own. Editing either field without
  forcing a regeneration does nothing. `scripts/_set_sudden_stable_attrs_and_research.ts` forces
  it; a proper fix is to hash the planner inputs the way `scoreInputsHash` does for scoring.

`scripts/_set_sudden_pitch_menu.ts` (dry run by default, `--apply` to write). Applied.

`pain_points` 4 → 3. Dropped the 1:1 entry entirely: it is the constitution's credibility claim,
not a problem the buyer has, and leaving it on the menu handed the model the answer to ask back
as a question. The three that remain are the concurrent-views repeat share, ad-funded margin,
and an unowned cost line.

`value_props` 4 → 5. Only entry 1 was reworded (it now says what it removes and carries the
simultaneity the mechanism needs); the three objection handlers are untouched. The new entry,
"runs without anyone on the video team owning it day to day", exists because the old menu had a
pain about an understaffed team and **nothing that answered it** — a draft picking that problem
had nothing to offer.

**Measured, same 8 accounts:** 3 distinct problems across 6 picks, 2 accounts `no_problem_fits`,
one draft pair over 45% overlap. Intigral now asks whether the delivery cost line has a single
owner or is split across groups; Cineverse asks whether delivery eats the ad yield per view.
Neither question was reachable from the old menu. The one draft still leading with the plain 1:1
question is idilio TV, which is precisely the account where the picker declined and the prompt
fell back to the full menu. That is the mechanism working, visible in a negative case.

**A measurement I got wrong and am correcting here:** "distinct problems chosen" is not a score.
A product that does one thing for one situation SHOULD converge on one argument, and five
accounts landing on the same problem is the menu being honest. What has to vary is the anchor
and the numbers, which the word-overlap check grades. `_dryrun_drafts.ts` now labels the spread
as diagnostic and says what to read it for: the picker refusing outright, or a problem nothing
ever selects.

**OVI Technologies: chased, root-caused, fixed.** It scored 0.95 while calling itself a "sub
second live streaming environment" whose own site says *"when we say Live, we mean LIVE."* The
veto was not broken and the score was not stale — `scoreEntity` returns null for it, meaning the
stored judgment was current under the current conditions. The rubric had **two facts with
opposite answers**:

```
company_description: "Live Streaming and Gaming Ecosystem ... sub second live streaming"
product:             "Film/TV Streaming, Sports Streaming"   <- imported taxonomy tag
```

Condition 1 requires live-only *with no on-demand catalog*, the `product` tag asserts a catalog,
and the block says to stop only on evidence rather than assumption. Refusing to veto was the
correct call on the evidence it had. **No rewording fixes this**, and rewording is the expensive
move anyway (`out_of_scope` is in `scoreInputsHash`, so an edit re-rubrics all 1961 accounts).

I also tried to size the class with a keyword sweep and it was useless: 1343 of 1841
descriptions matched "live-focused" because a VOD service that mentions live once matches.
KKTV and Film Movement Plus came back as candidates. That question cannot be answered by
matching strings, which is the whole argument for storing the answer.

**Fix, and it is item 2 + signal-extraction item 5 of this plan, now built:** ask the stable
questions once and store the answers as facts, so the veto reads a stated answer instead of
re-deriving one from contradictory prose.

- `policy.enrichment.stable_attributes` — `{ predicate, question, values[] }`, empty by default.
  Nothing about video, live or on-demand appears in code; which properties matter and what they
  are called is customer config, because "live versus on-demand" means nothing in another
  vertical.
- `scripts/backfill_stable_attributes.ts` — dry run by default, `--apply`, `--limit`,
  `--entity`. One cheap-model call per account. A value outside the configured list is dropped
  rather than stored, and "unknown" stores nothing: a wrong stable attribute is worse than a
  missing one, because the scorer will trust it for as long as it stands.
- Sudden configured with `delivery_mode` (live_only / on_demand_only / both) and `business_model`
  (operates_streaming_service / sells_to_streaming_services / neither), the second being exactly
  the predicate item 2 proposed.

**Verified on OVI:** with `delivery_mode=live_only` stored, the veto fires and cites it.
`icp_total` 0.95 → **0**, written. The reasoning now reads: *"delivery_mode=live_only;
company_description: 'when we say Live, we mean LIVE.'"*

**Not run across the book, because it is a real spend decision.** Sample of 25: `delivery_mode`
answered for 7 (3 live_only, 3 both, 1 on_demand_only), `business_model` for 20, nothing
rejected as an invented value. If 12% live-only holds across ~1800 candidates that is roughly
200 accounts that should be vetoed today and are not — but the sample is unordered, so treat the
rate as indicative. Cost of the full pass: ~1800 cheap-model calls, plus a rescore of every
touched account, which is the same order as the full rescore of 2026-08-04. Jake's call.

**CAUTION for whoever touches this next:** `pain_points` and `value_props` are re-derived from
the workspace About text by `deriveDefaults`, so saving About in Settings overwrites both lists.
If this menu survives contact with real replies, fold it back into About.

Watch on the first automated cycle after deploy: `angle_outcome` on `drafter_shortlist_pick`.
A run where most rows say `no_problem_fits` means the picker is refusing rather than choosing,
and the whole thing has quietly reverted to the old prompt.

### The original diagnosis, kept because it is what the fix was built against

**Hide the exemplar whose angle the model picked.** This is no longer a hypothesis. MBC Group,
re-drafted 2026-08-04 after every other fix was in, chose Template 2 and produced:

> As audience grows, does your delivery cost per viewer actually come down, or does it track 1:1
> with traffic? For most platforms it's 1:1 forever.

Template 2's exemplar asks *"does your delivery cost per viewer fall, or does the cost line grow
1:1 with it?"* and creds *"For most platforms it's 1:1 forever."* The draft is a synonym swap on
the question and a near-copy of the cred. STEP 7 explicitly bans exactly this, the content menu
was present, and it happened anyway.

The cause is structural, not a missing rule: template 2 hardcodes one angle in its exemplar
body, so picking that audience picks that question. Adding more prose telling the model not to
copy has now been tried twice and does not hold. What will: **never render an exemplar whose
angle matches the one the model is writing to.** Then the exemplar can only teach shape, because
the question it carries is not available to copy.

Requires splitting angle from template, which is the config work already described above. Do
that next; the content menu was the cheap half and it went as far as it can.

*(Built 2026-08-04 — see the section above for what shipped and what the measurement showed.)*

### Background: why this was the situation

The constitution allows exactly two credibility claims:

> "Two credibility claims are allowed and no others: that delivery cost usually grows one to one
> with audience, and that delivery is about 98 percent of streaming infrastructure spend, per
> AWS's own VOD table."

So the sameness is mandated, not accidental. This is working as intended and the 60-to-80-percent
figure and pay-from-savings pricing are deliberately held back until after a reply
(`_dryrun_drafts.ts:30` enforces it). Don't "fix" that.

What can vary is the **question**, which the constitution says nothing about. Right now it
doesn't, for three reasons:

1. Templates are indexed by audience (connector / founder / technical owner) but each hardcodes
   one argument, and STEP 7 says pick exactly one template. Choosing an audience silently chooses
   the argument.
2. `prompt_builders.ts:148` teaches the fork question using *"Does X fall, or does it grow 1:1?"*
   as its example. The one place the model is told what a good question looks like shows it the
   question we keep seeing.
3. Three full exemplar bodies sit in context and nothing points anywhere else.

Fixes, cheapest first:

- Rewrite line 148 to use two or three forks from different angles so no single phrasing anchors.
- Add an angle list to config (`when` / `think` / `cred`), separate from templates. Cred stays
  one of the two allowed claims or nothing.
- Require the model to name its chosen angle in `reasoning`, as it already names its template.
- **Never show an exemplar that uses the angle the model picked.** This kills shape-cloning
  structurally instead of asking the model not to clone.

## Item 6 — quoted bans and the noun-pile opener. DONE

### The principle, now recorded in the file header

Do not quote a banned string that would be a usable output in the slot the rule governs. The
model completes the pattern instead of avoiding it. Proven: STEP 6 read `no trailing fragments
like "Shows in your dashboard."` and the MBC draft ended with exactly that sentence.

Quoting is still correct in three places, all kept: the input formats the user message uses, the
ranked CTAs in STEP 5 (prescribed, not banned), and the industry-cliché bans whose whole value
is naming a phrase the model would reach for anyway. The test: could the quoted string be
dropped into this message and read as normal? If yes, describe the shape instead.

### Changed

- STEP 6: the trailing-fragment ban restated positively, as its own line. Every sentence has a
  subject and a verb, the closing one included.
- STEP 6: new rule that the FIRST sentence names them and something they did, because the old
  "open on them" line did not bind the opener and both bad drafts opened with a noun pile.
- STEP 8: `("X shows up in your dashboard")` removed — same phrase family as the leak.
- STEP 9: two new checks, one on the first sentence and one that reads the last sentence alone.
- STEP 2: `"The bill grows every time an episode drops"` removed. Sudden's vertical in shared code.
- STEP 1: the NOT-events examples genericized off video vocabulary.
- STEP 7: the vocabulary asymmetry stated outright — approved wording is the part that should
  stay word for word, the anchor and question are the parts that must change. The CHZZK draft
  did both backwards.

### Verified

MBC Group re-drafted after the change: *"Shahid's streaming is scaling fast — AVOD +27% YoY,
SVOD +25%."* Subject and verb in the opener, no trailing fragment, closes on a complete
question. Both defects gone.

### Two things this surfaced, neither fixed

- **The em dash.** The new MBC draft uses one. Jake's own writing rules ban em dashes outright.
  That is a voice preference, so it belongs in `policy.drafter.message_rules` (config), not in
  shared craft code. One line to add if wanted.
- **Every draft closes with the same CTA.** `"Want me to put your numbers to it?"` is ranked #1
  in STEP 5, so the model picks it nearly every time. Working as specified, but it is a real
  source of sameness across messages. Changing the ranking is an outreach-strategy call, not a
  bug fix.

## Item 8 — dates, and the bug that fixing them exposed. DONE

Started as "fix the dates upstream so Intigral drafts again". The literal fix made Intigral
worse, and finding out why exposed a real flaw in the age rule.

### The date backfill: correct, and almost irrelevant

`publishedDateFromUrl` already existed and works. Intigral's signals were ingested 2026-07-30,
one day before that code shipped, so the gap was stale data rather than broken code. The URL is
persisted in `structured_tags.url`, so it is recoverable with no LLM call and no re-fetch:
`scripts/backfill_url_published_dates.ts` (dry run by default, `--apply` to write).

Applied: **7 signals dated, out of 4208.** The real distribution is the finding:

| | count | share |
|---|---|---|
| already dated | 1065 | 25% |
| **no URL on the signal at all** | **2581** | **61%** |
| URL carries no date | 555 | 13% |
| recoverable from URL | 7 | 0.2% |

**Three quarters of signals carry no date.** No amount of URL parsing changes that. It means
theme-led mode is the only route most of this book will ever have to a draft, which makes the
next two fixes load-bearing rather than cosmetic.

### Fix 1: a theme may rest entirely on undated facts

STEP 1 described mode B as needing "two or more facts, from different dates or sources" and the
model read that as requiring dates. Now stated outright: mode B does not need a recent signal,
that is what mode A is for; two undated facts from different sources that agree are a theme and
are enough to write on. The honesty constraint is unchanged — describe the pattern as standing,
never as news.

### Fix 2: age kills events, not state

This is the one the date backfill exposed. Dating the VisualOn case study to 2025-03 pushed it
past `trigger_max_age_days` (90), and the old rule said facts older than that are "dead weight in
both modes". So Intigral **lost its second source by having a date added**, and went from
drafting to gating. Dating a fact must never delete it.

The rule now distinguishes:
- An **event** older than the window is dead weight. It happened, it is over.
- A fact describing how the company **stands** — what it runs on, who it buys from, what it has
  invested in, what it said it was trying to fix — does not expire because the page reporting it
  is old. A two-year-old case study saying they adopted a particular encoder is still true about
  their stack. It can never be the news, but it is legitimate theme evidence.

The prompt already granted exactly this to *undated* facts. The bug was that dating a durable
fact demoted it below an undated one.

### Result

Intigral drafts again, theme-led, on the Bitmovin consolidation plus the stated OPEX goal:

> Hey Bill, saw you moved to Bitmovin and set OPEX reduction as a core goal. As your massive
> MENA audience scales, does delivery cost per stream stay flat, or climb with every viewer?

The angle justification is also visibly working in the reasoning field: it names the problem it
chose and rejects the other three by name ("repeat-segment visibility requires a different entry
point, staffing scale isn't indicated, delivery as dominant cost is too general without a
specific spike context").

## Signal extraction — findings for a separate session

Nothing here was fixed. It is written down because the 8-account grading run on 2026-08-04 made
it clear that the research side, not the writing side, is now what limits draft quality. A
message can only be as specific as the facts behind it.

### 1. Half the top accounts have nothing to write on

4 of the top 8 by score gated, three of them for the same reason: no recent dated event.

> ShowMax — GATE: Need a recent dated event showing ShowMax's current scaling or CDN cost pain,
> such as a country launch, viewership number, or engineering hire.

That is the drafter behaving correctly (a message not sent costs nothing), but these are the
highest-scoring accounts in the book. They score high on evidence_depth and industry_match and
still carry nothing datable. The research planner is finding descriptions of companies, not
events. That gap is the single biggest cap on draft quality right now.

Worth checking: whether `research_strategy.ts` angles bias toward "what is this company" over
"what did this company just do", and whether the freshness window is dropping events that were
found but judged stale.

### 2a. Contacts from notes. DONE — 50 created, 48 accounts unblocked

`scripts/extract_contacts_from_notes.ts` (dry run by default, `--apply` to write). Pulls people
named in `prospect_notes` into real contact entities via `linkContactByProspectId`, which needs
no email and is idempotent on (account, lowercased name).

Result: **64 people found across 48 accounts, 50 contacts created** (the other 14 were the same
person named in two notes, correctly deduped). Accounts with at least one contact went from ~71
to **119**. Cineverse, Intigral, Holywater and 45 others went from undraftable to draftable at
zero provider cost.

The prompt is deliberately strict because the notes are messy, and a wrong contact is worse than
none — the drafter opens the message with that person's name. It refuses intermediaries
("Through Mohsen Lhaf", "Introduced to Sam through Kirsti"), anyone the note says has left,
bare pronouns ("she reached out"), and a name pasted next to a LinkedIn URL belonging to someone
else ("Andrea Meneses - linkedin.com/in/ryan-barnes-..."). Hit rate 25% of notes scanned; most
notes only record outreach history and correctly yield nobody.

Model: `deepseek-v4-flash`, matching `classify_role.ts`. Not a swap of any configured model.

Known wart: some extracted roles carry spreadsheet artifacts ("Sales Pipeline Lead" looks like a
CSV column, not a job title). Harmless for addressing, but it can nudge template-audience
selection. Worth a pass if audience picks look wrong.

### 2b. The harness was reading contacts from the wrong place. FIXED

`create_contact` links a contact by asserting a **works_at fact**. `action_selector.ts:417`
reads facts, so production was always correct. But `_dryrun_drafts.ts` and `_dryrun_account.ts`
both queried `attributes.works_at`, which nothing ever sets — so **every dry run reported "0
contacts" for every account**, whether or not contacts existed.

That is why the 8-account grading run showed zero contacts across the board and I read it as a
contact-coverage problem. Part of it was, but part was the harness lying. Both scripts now read
works_at facts and pull role/email from facts, and neither requires an email any more, since the
linkedin channel never uses one.

Lesson worth keeping: when a measurement says every single row is zero, suspect the measurement.

### 2c. The provider is still wrong for this channel

Unchanged and still true: `enrichment.contact_provider` is `hunter` at 50/month. Hunter finds
EMAIL addresses; a LinkedIn workspace needs name, role and profile URL. 50/month against ~900
accounts covers about 5% a month even when it works. Either switch to a provider that returns
role and profile, or stop spending the cap on a field the channel does not use.

### 2. Zero contacts on all eight (superseded by 2a/2b above)

Every one of the top 8 printed `0 contacts`. `action_selector.ts:230` requires
`best_contact_score !== undefined` before it will draft, so in production most of these route to
`enrich_contacts` rather than to a message. Weyyak gated on exactly that:

> GATE: No recipient role or contact available to select a template audience.

The dry-run harness bypasses that gate, which is why drafts appeared at all. So the measured
draft quality above is from accounts that would not currently draft in production. Contact
enrichment is the bottleneck sitting in front of everything in this document.

### 3a. The changed_at trap is designed out. FIXED

`policy.scoring_config_state.changed_at` was the only thing that could get an unchanged account
past the skip-when-stale guard, so every writer of a scoring input had to remember to bump it —
and a settings save, a wizard step or a one-off script all could (and did) forget, after which
the edit silently never applied to anything.

`scoring.ts` now also compares the freshly computed `inputs_hash` against the one stored on the
account's `icp_fit_breakdown`. That fingerprint already covers icp, about, persona and
out_of_scope, so a config change is detected without anyone opting in. `changed_at` stays as a
belt-and-braces trigger. Unknown or unparseable stored hash means score rather than skip.

Costs nothing measurable: an account whose hash still matches falls through the guard into the
reuse path and returns the stored judgment with `llm_called=false`. Verified on MBC Group and
Weyyak (both reused, no LLM call) and TVU Networks (skipped outright).

### 3b. company_description contamination. SWEPT — 13 of 1783 (0.7%)

`scripts/_sweep_company_description.ts` (read-only). Two-stage: a first-person/resume heuristic
shortlists rows so we don't pay a completion for ~1800 of them, then the shortlist is read by
hand. The heuristic decides what to LOOK at, never what is wrong — it flagged GlobalTV purely
for starting with the word "Global", which is why that pattern is now gone.

**It is real and it changes scores.** From the scorer's own stored reasoning:

- **Minutus Computing, `industry_match = 0`** — *"a consulting firm focused on packaging and
  sustainability, not media/streaming."* That is a contact's LinkedIn bio about sustainable
  packaging being read as the company's business. The account is scored to zero off a resume.
- **Accedo TV, 0.7** — reasoning cites the business-development profile.
- **Verizon, 0.7** — "the description clearly references digital…".
- Pluto TV and Prime Video carry bios too but still scored 1.0, because `product=Film/TV
  Streaming` outweighed them. Contamination does not always bite.

Affected: Accedo TV, Ross Video, Verizon, AWS (x2), Pluto TV, Everyone TV, Minutus Computing,
TVU Networks, Greening of Streaming, Prime Video, EstateMin, plus GammaTime — whose value is not
a bio at all but a hand-written sales note ("Ex-Google Gaming + ex-Quibi background = will
understand CDN offload math instantly"), filed under the wrong predicate.

### 3c. Misfiled facts moved. FIXED — 13 of 13

`scripts/fix_misfiled_facts.ts` (dry run by default, `--apply` to write). Each fact id is listed
individually with its account and target predicate, because a wrong move here silently edits
what the scorer believes about a real company. Nothing is deleted: each is superseded by a new
fact carrying the same text under the right predicate, so the original stays in the chain.

- 12 person bios → `misfiled_person_bio`, which is now in `ADMIN_PREDICATES` so it is neither
  read as company info nor counted toward `evidence_depth`. Parking a fact must not inflate the
  evidence score of the account it was polluting.
- 1 sales note (GammaTime) → `prospect_notes`, where the drafter already reads it as context.
  It was useful, just not a company description.

Verified: 12 new facts each superseding an original, originals retained, and Minutus Computing
and TVU Networks now carry no active `company_description` at all. Affected accounts re-rubric
on their next scoring run automatically, because the fact set changed and `inputs_hash` with it.

### 3d. The sweep script had the same class of bug it was hunting

Right after the fix ran, the sweep still reported 13 suspects and the fix looked like a no-op.
It was not: the sweep computed "active" from `supersedes` pointers found *within its own
predicate query*, so a fact moved to a DIFFERENT predicate is superseded by a row the query
never sees. Now it looks up supersedes across all predicates. Re-sweep reads 0 suspects, 1770
active (down from 1783 by the 13 moved).

Worth remembering: any "is this fact still active" check that filters by predicate first will
mis-report cross-predicate supersedes.

### 3e. Other prose predicates. SWEPT — clean

- `pain_observed` (51 rows): 0 suspects.
- `prospect_notes` (310 rows): the person-bio lens does not apply, since a first-person voice is
  expected — these are hand-written. Checked the inverse instead (long, no first-person voice =
  possible scraped marketing copy): 54 matched the pattern, all read as genuine terse sales notes
  (referral chains, TIER 1/2 priority calls, a meeting note in French). No contamination.
- `icp_fit_breakdown` is the scorer's own output and already admin. Not swept.

So the misfiling was confined to `company_description`, which is also the only prose field the
ICP rubric reads directly. That is consistent with how it was noticed in the first place.

### 3. Facts about a person land on the company (superseded by 3b)

TVU Networks carries `company_description :: "Ex-AWS, Principal Partner Solutions Architect,
Media & Entertainment. My role involves..."` — a contact's LinkedIn bio stored as a fact about
the account. The scorer reads `company_description` when judging industry_match, so a person's
resume is being scored as if it described the business.

Unknown how widespread this is. Worth a sweep for `company_description` values written in the
first person before trusting that predicate anywhere.

### 4. The good facts show what "good" looks like

SOOP is the counterexample and worth studying as the target shape. It carries
`network_usage_cost :: Q1 2026 6.2 billion KRW (up 26% YoY)`, `current_cdn_providers :: gs_cdn,
lg_cdn`, `streaming_traffic_trend :: Declined in Q1 2026`. Those produced the best draft in the
whole session, the one that opened on their own cost line rising while traffic fell.

The pattern: a number, a unit, a period, and a direction. Facts shaped like that give the writer
something only an insider would notice. Facts shaped like "is a streaming platform" do not.

### 5. Live versus VOD is not a stored attribute

The whole out-of-scope veto has to re-derive "are they live-only" from prose facts on every
scoring call. It is a stable property of a business and should be a fact asserted once. Same for
"operates a streaming service" versus "sells to companies that do". See item 2 above.

## Item 7 — learning from rejections

Wanted: the drafter gets better without anyone writing a book.

Not fine-tuning. Add a typed reject reason at the gate (`bad_trigger`, `wrong_angle`,
`cred_unsourced`, `shape_clone`, `out_of_scope`, `tone`), feed the last N rejected drafts for
that workspace back into the prompt as negative examples with the reason attached, and when one
reason crosses a threshold, surface it as a proposed new `message_rule`.

Negative examples with reasons push away from the clone. More positive exemplars is what caused
the cloning in the first place.

Needs a look at the gate schema first to see what reject metadata already exists.

---

## Open questions for Jake

1. Is condition 3 (native/TV apps only, no web player) real, or should it be deleted?
2. Is TVU a partner or competitor rather than a prospect? If so we need a way to mark that,
   separate from out-of-scope.
3. Rescore the book against the new conditions? It costs ~1961 rubric calls. Not needed for
   safety, since the drafter refuses regardless, but it would make `icp_fit` honest and let you
   query who's disqualified and why.
4. Is there a minimum concurrent audience below which the swarm doesn't form? That would be a
   fourth condition and no marketing page anywhere contains it.
