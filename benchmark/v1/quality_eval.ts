/**
 * Quality + hallucination eval for the v1 drafts.
 *
 * Judges the drafts each platform ALREADY generated (stored in runs.jsonl)
 * against the ground-truth facts every platform was seeded with (the committed
 * agent-crm projection per account). Blind to platform, one rubric for all.
 *
 * Measures, per platform:
 *   - hallucination: factual claims in the draft not supported by / contradicting the truth
 *   - quality: specificity, relevance of the angle, personalization
 *
 *   pnpm benchmark:v1:quality   (needs DEEPSEEK_API_KEY for the judge; no DB, no competitor keys)
 *
 * Honest caveats (also in METHODOLOGY.md):
 *   - Judge is deepseek-reasoner, the same family that wrote EVERY draft. Because the
 *     generator is identical across platforms, this does not favor one platform, but a
 *     cross-family judge would be cleaner. Swap the judge call to re-run.
 *   - Grounding is checked against the shared seeded truth, not each platform's exact
 *     byte-level input. A false claim about the account is a defect for the buyer
 *     regardless of which format produced it.
 *   - n <= 18 drafts/platform. Directional, not four-significant-figures.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callDeepSeek } from './lib/llm.js';
import type { RunRow } from './lib/summary.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = join(here, 'results', 'runs.jsonl');
const RECEIPTS = join(here, 'receipts', 'agent-crm');
const OUT = join(here, 'results', 'quality_runs.jsonl');

const CANONICAL: Record<string, string> = { 'agent-crm': 'prod-text', twenty: 'tight', hubspot: 'tight', dayai: 'tight', attio: 'tight' };
const PLATFORM_ORDER = ['agent-crm', 'twenty', 'hubspot', 'dayai', 'attio'];
const LABEL: Record<string, string> = { 'agent-crm': 'agent-crm', twenty: 'Twenty', hubspot: 'HubSpot', dayai: 'Day.ai', attio: 'Attio' };
const POOL = 6;
// internal scoring artifacts, not company facts
const SKIP_PRED = /^(score_|icp_fit|dropped_until|rrf_)/;

interface Projection {
  account: { name: string; attributes?: Record<string, unknown> };
  facts: Array<{ predicate: string; object: string | null }>;
  contacts: Array<{ name: string; email: string; role: string }>;
  past_touch: { body: string; days_ago: number } | null;
  signals: Array<{ type: string; body: string }>;
}

function truthFor(account: string): string {
  const proj = JSON.parse(readFileSync(join(RECEIPTS, `${account}_run1_draft_projection.json`), 'utf8'))
    .payload.projection as Projection;
  const facts = proj.facts.filter((f) => !SKIP_PRED.test(f.predicate)).map((f) => `- ${f.predicate}: ${f.object}`);
  const contacts = proj.contacts.map((c) => `- ${c.name}${c.role ? ` (${c.role})` : ''} <${c.email}>`);
  const signals = proj.signals.map((s) => `- [${s.type}] ${s.body.replace(/\s+/g, ' ').slice(0, 500)}`);
  const dom = (proj.account.attributes?.domain as string | undefined) ?? '';
  return [
    `COMPANY: ${proj.account.name}${dom ? ` (${dom})` : ''}`,
    '', 'KNOWN FACTS:', ...(facts.length ? facts : ['- (none)']),
    '', 'KNOWN CONTACTS:', ...(contacts.length ? contacts : ['- (none)']),
    '', `PRIOR TOUCH: ${proj.past_touch ? proj.past_touch.body.replace(/\n/g, ' ') : '(none)'}`,
    '', "SOURCE MATERIAL SEEN (may be noisy or self-contradicting):", ...(signals.length ? signals : ['- (none)']),
  ].join('\n');
}

const SYSTEM = `You are a strict, impartial evaluator of B2B sales outreach drafts. You are given (A) the TRUE, known information about a company and (B) a draft an AI wrote about that company. Judge ONLY against the provided truth. Do not reward length or polish. A claim is "unsupported" if a factual assertion in the draft about the company is not backed by the provided truth, or contradicts it. Noisy or self-contradicting source material is NOT license to assert one side as established fact. The draft may be JSON; evaluate the email/message text inside it and ignore ids and metadata. Return ONLY JSON.`;

function userPrompt(truth: string, draft: string): string {
  return `${truth}

=== DRAFT TO EVALUATE ===
${draft}

=== RETURN ONLY THIS JSON ===
{"unsupported_claims": ["each factual assertion about the company that is not backed by the truth above"], "specificity": 1-5, "relevance": 1-5, "personalization": 1-5}
specificity = how concretely it references real, known details. relevance = how well the chosen angle fits what is known. personalization = how tailored to this company vs a generic template.`;
}

function parseJson(s: string): Record<string, unknown> | null {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

async function main() {
  const rows: RunRow[] = readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRow);

  const truths: Record<string, string> = {};
  const drafts = rows.filter((r) => r.ok && r.workload === 'draft' && r.draft && CANONICAL[r.platform] === r.shape);
  for (const a of [...new Set(drafts.map((r) => r.account))]) {
    try { truths[a] = truthFor(a); } catch { /* no projection receipt -> skip this account's drafts */ }
  }
  const LIMIT = Number(process.env.QUALITY_LIMIT) || Infinity;
  const work = drafts.filter((r) => truths[r.account]).slice(0, LIMIT);
  console.error(`judging ${work.length} drafts across ${PLATFORM_ORDER.length} platforms...`);

  const verdicts: Array<Record<string, unknown>> = [];
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < work.length) {
      const r = work[idx++];
      const draft = typeof r.draft === 'string' ? r.draft : JSON.stringify(r.draft);
      try {
        const res = await callDeepSeek([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt(truths[r.account], draft) },
        ]);
        const j = parseJson(res.content ?? '');
        if (j && Array.isArray(j.unsupported_claims)) {
          verdicts.push({
            account: r.account, platform: r.platform, run: r.run,
            unsupported: j.unsupported_claims as string[],
            specificity: Number(j.specificity) || 0,
            relevance: Number(j.relevance) || 0,
            personalization: Number(j.personalization) || 0,
          });
        } else {
          verdicts.push({ account: r.account, platform: r.platform, run: r.run, judge_error: 'unparseable' });
        }
      } catch (e) {
        verdicts.push({ account: r.account, platform: r.platform, run: r.run, judge_error: String(e).slice(0, 160) });
      }
      console.error(`  ${++done}/${work.length}`);
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));

  writeFileSync(OUT, verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log('\nQUALITY + HALLUCINATION  (draft workload, judged blind against seeded truth)');
  console.log('platform     | N  | unsupported/draft | % clean | specificity | relevance | personalization');
  console.log('-------------|----|-------------------|---------|-------------|-----------|----------------');
  for (const p of PLATFORM_ORDER) {
    const vs = verdicts.filter((v) => v.platform === p && !v.judge_error) as Array<{ unsupported: string[]; specificity: number; relevance: number; personalization: number }>;
    if (!vs.length) continue;
    const unsup = vs.map((v) => v.unsupported.length);
    const clean = (vs.filter((v) => v.unsupported.length === 0).length / vs.length) * 100;
    console.log(
      `${LABEL[p].padEnd(12)} | ${String(vs.length).padStart(2)} | ${mean(unsup).toFixed(2).padStart(17)} | ${clean.toFixed(0).padStart(6)}% | ${mean(vs.map((v) => v.specificity)).toFixed(2).padStart(11)} | ${mean(vs.map((v) => v.relevance)).toFixed(2).padStart(9)} | ${mean(vs.map((v) => v.personalization)).toFixed(2).padStart(15)}`,
    );
  }
  const errs = verdicts.filter((v) => v.judge_error).length;
  console.log(`\nverdicts -> ${OUT.split('/agent-crm/')[1] ?? OUT}${errs ? `   (${errs} judge errors excluded)` : ''}\n`);
}

main();
