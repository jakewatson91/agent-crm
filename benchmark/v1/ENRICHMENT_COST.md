# Enrichment economics: the system is the product, the provider is swappable

## The frame (read this first)

agent-crm does **not** compete with Clay / Apollo / Hunter / Explorium / ZoomInfo. Those are **enrichment providers** — swappable inputs. You plug in whichever data or research source you want; you could even point Clay or Apollo *into* agent-crm as a source. Comparing "our enrichment price vs Clay's enrichment price" is the wrong comparison, and an earlier version of this doc made that mistake.

The right comparison is **apples to apples on the actual job**: keep a book of accounts enriched with fresh, sourced signals and scored for fit — using the *same* LLM and the *same* web access — **with vs without agent-crm's system** (its research instructions, its data model, its scoring) wrapped around it.

The honest baseline is what a founder actually does today: **run Claude (or a Claygent table) to research each account and extract signals, every day.** Same model. Same web. The question is what the *system* around that model is worth.

Answer, measured on a real book: the system spends the extraction model on **25% of the runs** a naive per-signal approach would, throws out **24% of fetched research as off-target before the model ever runs**, and turns each survivor into a **sourced, deduped, scored fact** that hallucinates ~3× less downstream — all-in **$0.075 per account per month**, of which the AI reasoning is **$0.006**. The advantage is the system, not the data feed.

## The unit of work

Cost-per-run is a vanity metric. The unit that matters is a **useful signal**: fresh (not a duplicate you already have), current (not a 2013 article), on-target (about this company, relevant to what you sell), and **stored so it's citable and scorable**. A DIY loop pays full price for every run, but most runs produce a duplicate, a stale page, or unstructured text a human must clean. Its cost *per useful unit* is far above its cost per run. agent-crm's whole system exists to raise that yield.

## Measured cost (Sudden, 30 days — `enrichment_cost_audit.ts`)

| Component | 30-day spend | per account | share |
|---|---|---|---|
| Exa web read (1,740 searches) | $17.40 | $0.0685 | 92% |
| Scoring LLM (est., upper bound) | $1.15 | $0.0045 | 6% |
| Enricher LLM (594 runs) | $0.39 | $0.0015 | 2% |
| Embeddings (est.) | $0.05 | $0.0002 | <1% |
| **Total** | **$18.98** | **$0.075** | |

254 accounts worked, 615 research passes, ~1,400 signals. **$0.031 per research pass; $0.075/account for a month of maintained enrichment. The AI reasoning is $0.006 — nearly free. You pay for the web read, which is the swappable part.**

## Why the yield is higher — the system as a multiplier (measured)

These are the mechanisms a raw provider or a DIY loop doesn't have. Each is measured on Sudden, 30 days (`system_yield_audit.ts`).

1. **It knows what's worth reading.** The research relevance / same-name filter drops **436 of 1,841 fetched results (24%)** as off-target *before* any extraction model runs. A DIY loop pays to extract from that junk.
2. **It doesn't re-do work.** Burst-coalescing + duplicate-body dedup **skipped 1,774 extraction runs**; the system ran **594 (25%)** of the 2,368 a naive per-signal extractor would. That is **4× fewer model runs for the identical input stream** — before any model-price or cadence difference.
3. **It doesn't pay for stale or duplicates.** The recency floor + same-URL + near-dup collapse (shipped, deploying) removed 3 stale sources and merged Natyf's 3-article launch into 1, Totalplay's 30 signals → 27, in the verification run. This adds to the 24% pre-model waste-removal once live.
4. **Each extraction is single-shot, not an agent loop.** Targeted search → one extraction call (the v1 benchmark measured 1 LLM call vs 3–5 for tool-loop CRMs) → fewer tokens per useful fact.
5. **The model is cheap, at cost, and cached.** DeepSeek-v4-flash at wholesale, 87% prompt-cache hit → $0.003/extraction. The same extraction on Claude Sonnet ≈ $0.04 (~60×). A DIY loop typically reaches for a premium model.

**End-to-end: 1 model extraction per 3.1 raw results fetched.** The system concentrates model spend on the fraction of work that produces a fresh, on-target signal.

## Apples-to-apples vs "run Claude every day"

Same 254 accounts, same model, same web access, 30 days:

| | Model extraction runs | Output |
|---|---|---|
| **agent-crm** | **594** (measured) | Sourced, deduped, scored facts |
| DIY, per-signal (no dedup/coalesce) | 2,368 | Unstructured; duplicates pile up |
| DIY, "research every account daily" | 254 × 30 = **7,620** | Unstructured; mostly re-reads finding nothing new |

Both DIY variants produce roughly the *same* count of genuinely-new signals as agent-crm — new signals are rare per account per day — so they pay **4× (per-signal) to ~13× (daily)** more model runs for the **same useful yield**. Layer on: each DIY run reads more pages in an agent loop (~3× tokens), usually on a premium model (~20–60×/token), and its output is unstructured — not scorable, not dedupable, not citable. So a human cleans it, or the downstream draft hallucinates (`QUALITY.md`: record-blob approaches produce ~3× more unsupported claims than agent-crm's atomic sourced facts).

The multipliers **stack**, but the honest headline stays measured and modest: **holding the model identical, the system runs extraction 4–13× fewer times for the same fresh-signal yield, and drops ~24%+ of research as junk before the model** — then makes the survivors usable in a way the DIY output isn't.

## Quality (the other half of "per unit of work")

From `QUALITY.md` (blind judge, one rubric, shared seeded truth): drafts off agent-crm's data show **0.28 unsupported claims/draft, 78% clean** vs HubSpot 0.94/44%, Attio 0.83/56%. Three things a flat record or a DIY text dump can't do:

1. **Every fact is sourced** — bound to its signal + URL, content-hashed (duplicates can't accumulate), superseded when it changes (never silently stale). The draft cites real evidence; the score is explainable.
2. **Live signals, not firmographics** — launches, hiring, partnerships, and the pain behind them, from current pages. The hook a static record doesn't carry.
3. **Scored on every new fact** — an ICP score with a breakdown, which also decides *which accounts merit more research spend* — closing the loop back to mechanism #1 above.

## Where the providers fit

Hunter, Explorium, Apollo, Vibe, Clay — all are **sources you configure**, not competitors. The system's job is to extract the most clean, sourced, scored yield per dollar from *whatever* you plug in. That is why the cost-and-quality story is provider-agnostic: change the data feed and the multiplier still holds, because the multiplier is the instructions + data model + scoring, not the feed.

## Honest caveats

- **Scoring cost is an upper bound** (many scores skip the LLM at the RRF prefilter) — true cost is below $0.075.
- **The DIY baseline uses stated assumptions** (daily cadence per Jake's framing; ~3× tokens/run for agent-loop browsing; premium-model pricing as an *additional* lever, not baked into the 4–13× run-count claim). The 4× per-signal and 24% junk-removal numbers are measured, not assumed.
- **A DIY builder could add dedup/recency/scoring** — but then they are rebuilding this system. That is the point: the system is the accumulated discipline, not a data source.
- **One workspace, 30 days.** Per-account cost scales with re-research cadence.
- **Not a contact-data vendor.** For verified emails/phones agent-crm calls a provider (Hunter/Explorium/Vibe). The win is on research-and-reason-and-store, not on being a phone database.

## Reproduce

```
DOTENV_CONFIG_PATH=.env.local WS=<id> DAYS=30 npx tsx benchmark/v1/enrichment_cost_audit.ts
DOTENV_CONFIG_PATH=.env.local WS=<id> DAYS=30 npx tsx benchmark/v1/system_yield_audit.ts
```

Prices + sources: `benchmark/v1/lib/pricing.ts`. Quality: `benchmark/v1/QUALITY.md`.
