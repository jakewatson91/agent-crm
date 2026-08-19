# v1 Quality + Hallucination Eval

Does agent-crm's data organization actually produce better agent output, or just cheaper? This measures it. Honest answer: better than the live row-based CRMs, clearly, but not a clean sweep, and we throw out one platform's result as confounded.

## Method

- Judge the **draft** the each platform already generated (`results/runs.jsonl`), against the **ground-truth facts every platform was seeded with** (the committed agent-crm projection per account, `receipts/agent-crm/<account>_run1_draft_projection.json`). The same facts were mirrored into HubSpot / Attio / Twenty / Day.ai at seed time, so one shared truth per account is fair.
- The judge is **blind** to which platform wrote the draft, one rubric for all. It returns the list of unsupported claims (assertions about the company not backed by the truth) plus 1-5 scores for specificity, relevance, personalization.
- `pnpm benchmark:v1:quality`. Needs a judge model key (DEEPSEEK_API_KEY); no DB, no competitor keys. Per-draft verdicts are written to `results/quality_runs.jsonl` for inspection.

## Results (draft workload, n≈18 per platform)

**The judge is nondeterministic and the hallucination count moves a lot between passes.** The eval
was run three times on the identical committed drafts. All three passes are shown, oldest first.
Quote the range, never a single pass.

| Platform | unsupported claims / draft | % drafts clean |
|---|---|---|
| **agent-crm** | 0.28 / 0.65 / 0.72 | 78% / 53% / 44% |
| Twenty | 0.33 / 0.56 / 0.65 | 67% / 67% / 53% |
| HubSpot | 0.94 / 1.00 / 0.94 | 44% / 50% / 41% |
| Attio | 0.83 / 1.33 / 1.56 | 56% / 56% / 44% |
| _Day.ai (simulated, see caveat)_ | _0.24 / 0.76 / 0.88_ | _82% / 47% / 59%_ |

The 1-5 judge ratings are far more stable than the claim count, and they are the numbers worth
citing:

| Platform | specificity | relevance | personalization |
|---|---|---|---|
| **agent-crm** | **3.56 / 3.35 / 3.39** | **4.39 / 4.29 / 4.22** | 3.78 / 3.47 / 3.50 |
| Twenty | 2.89 / 2.94 / 2.65 | 3.22 / 3.33 / 3.18 | 3.11 / 2.78 / 2.76 |
| HubSpot | 2.94 / 2.61 / 2.76 | 3.11 / 2.72 / 2.94 | 3.11 / 2.44 / 2.71 |
| Attio | 3.22 / 3.06 / 3.25 | 3.33 / 3.39 / 3.31 | 3.11 / 2.89 / 3.13 |
| _Day.ai (simulated)_ | _4.18 / 4.06 / 4.29_ | _4.76 / 4.41 / 4.29_ | _4.18 / 3.94 / 4.24_ |

## Honest reading

- **The relevance and specificity gap is the finding that survives repetition.** agent-crm lands 4.22-4.39 on relevance in every pass against 2.72-3.11 for HubSpot, 3.31-3.39 for Attio and 3.18-3.33 for Twenty, and it beats all three on specificity in all three passes. This is the number to cite.
- **agent-crm fabricates fewer external facts than HubSpot and Attio in every pass**, and this survives the confound check below. HubSpot invents history and timing; Attio invents funding, industry, and location. The *direction* is consistent; the *size* is not (the HubSpot gap ranged from 3.4x down to 1.3x across passes), so cite the direction and never a multiple.
- **It does NOT beat Twenty on hallucination.** Twenty came out ahead in two of the three passes. The original 0.28-vs-0.33 gap was mostly Twenty leaking internal score fields we should not have seeded (see Confound check). Treat agent-crm and Twenty as equal on fabrication; the agent-crm edge over Twenty is on relevance and specificity only.
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
- **n is small and the judge is noisy.** 18 drafts per platform, and re-running the identical eval on the identical drafts moved agent-crm's claim count from 0.28 to 0.72 and Attio's from 0.83 to 1.56. The claim count is only usable as a direction, never as a headline figure. The 1-5 ratings held to within ~0.2 across passes and are safe to quote.
- **Draft workload only.** Brief and score were not judged here.
