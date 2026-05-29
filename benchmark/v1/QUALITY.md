# v1 Quality + Hallucination Eval

Does agent-crm's data organization actually produce better agent output, or just cheaper? This measures it. Honest answer: better than the live row-based CRMs, clearly, but not a clean sweep, and we throw out one platform's result as confounded.

## Method

- Judge the **draft** the each platform already generated (`results/runs.jsonl`), against the **ground-truth facts every platform was seeded with** (the committed agent-crm projection per account, `receipts/agent-crm/<account>_run1_draft_projection.json`). The same facts were mirrored into HubSpot / Attio / Twenty / Day.ai at seed time, so one shared truth per account is fair.
- The judge is **blind** to which platform wrote the draft, one rubric for all. It returns the list of unsupported claims (assertions about the company not backed by the truth) plus 1-5 scores for specificity, relevance, personalization.
- `pnpm benchmark:v1:quality`. Needs a judge model key (DEEPSEEK_API_KEY); no DB, no competitor keys. Per-draft verdicts are written to `results/quality_runs.jsonl` for inspection.

## Results (draft workload, n=18 per platform, 17 for Day.ai)

| Platform | unsupported claims / draft | % drafts clean | specificity | relevance | personalization |
|---|---|---|---|---|---|
| **agent-crm** | **0.28** | **78%** | 3.56 | 4.39 | 3.78 |
| Twenty | 0.33 | 67% | 2.89 | 3.22 | 3.11 |
| HubSpot | 0.94 | 44% | 2.94 | 3.11 | 3.11 |
| Attio | 0.83 | 56% | 3.22 | 3.33 | 3.11 |
| _Day.ai (simulated, see caveat)_ | _0.24_ | _82%_ | _4.18_ | _4.76_ | _4.18_ |

## Honest reading

- **agent-crm clearly fabricates real external facts less than HubSpot and Attio**, and this survives the confound check below. HubSpot invents history and timing; Attio invents funding, industry, and location.
- **It does NOT clearly beat Twenty on hallucination.** The aggregate gap over Twenty (0.28 vs 0.33) was mostly Twenty leaking internal score fields we should not have seeded (see Confound check). On genuine fabrication of external content, Twenty is as clean as us or cleaner. agent-crm scores higher on specificity and relevance, but those are softer judge ratings, not the hard hallucination count, so the Twenty quality edge is unproven.
- **Day.ai scored best, and we do NOT claim it.** Day.ai is the one simulated platform: its data comes from reshaping agent-crm's own clean projection (`lib/dayai/simulator.ts`), so it inherited clean inputs. Its score reflects the simulator, not Day.ai's real product. Excluded from the claim, shown in italics for honesty.
- **agent-crm is not flawless.** 0.28 unsupported claims per draft is low, not zero (e.g., one draft misattributed a LinkedIn post to the wrong contact). We are better here, not perfect.

## Why the live row CRMs fabricate more (from the flagged claims)

The judge's flags show the mechanism, not just a number:
- HubSpot leaked an internal suppression flag into an email ("set to pause until 2100", from a `dropped_until` marker) and invented contact history ("Jake followed up with Ziv last week").
- Attio fabricated a funding figure ("$125M raised") and leaked an internal score ("AI readiness score came in at 0.9").

These are the failure mode of handing a model a raw record blob: it cannot tell a real company fact from an internal field, so it writes the internal field into outbound. agent-crm's drafts draw from atomic, labeled facts, so they leak less, though not never.

## Confound check (is this real or a test artifact?)

Three threats to validity, checked against the data:

1. **Prompt asymmetry — ruled out.** `lib/workloads.ts` gives every platform a verbatim-identical rules block; only the one-line tool-flow differs. The edge is not a nicer prompt.
2. **Seeding artifact — partly real, and it inflates the competitor numbers.** We seeded competitors with agent-crm's internal score fields (`icp_fit`, ICP breakdown, AI-readiness) that the production projection strips before our own agent sees them, so competitor models read "AI readiness 0.9" and wrote it into outbound. Bucketing every flagged claim: of Twenty's 6 flags ~4 are these internal-field leaks; of HubSpot's 17, ~9. Strip them and count only genuine external fabrications (made-up funding, invented history, wrong industry): agent-crm ~5, Twenty ~2, HubSpot ~8, Attio ~12 per 18 drafts. The advantage holds vs HubSpot/Attio; it disappears vs Twenty.
   - Cleanest unconfounded case: `dropped_until` / "2100" was fed to BOTH agent-crm and HubSpot (verified in the receipts); HubSpot wrote it into the email, agent-crm did not. Same input, different output.
3. **Account concentration — real caveat.** Fabrications cluster on 2 of 6 accounts (Trigify.io, Explorium, both with ambiguous or self-conflicting data). On the other 4, platforms are about even.

**To settle it properly:** re-seed every platform with only the external facts the projection exposes (strip internal scores everywhere, equally), add more hard accounts, and re-judge with a cross-family model. Until then this is directional: solid vs HubSpot/Attio, not established vs Twenty.

## Caveats (do not skip)

- **Judge family.** The judge is deepseek-reasoner, the same model family that wrote every draft. Because the generator is identical across all platforms, this does not favor one platform, but a cross-family judge (e.g. a GPT or Claude model) would be cleaner. Swap the judge call and re-run to check.
- **Grounding bar.** Claims are judged against the shared seeded truth, not each platform's exact byte-level input. For a buyer, a false claim in an outbound email is a defect regardless of which format produced it, so this is the right bar, but it is not "faithfulness to your own input."
- **n is small.** 18 drafts per platform. Treat gaps under ~0.2 (e.g. agent-crm vs Twenty on hallucination, 0.28 vs 0.33) as noise; treat the 3x gaps (vs HubSpot/Attio) as real.
- **Draft workload only.** Brief and score were not judged here.
