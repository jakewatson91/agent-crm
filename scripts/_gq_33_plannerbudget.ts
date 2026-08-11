/**
 * How much room does the strategy planner actually need?
 *
 * It runs deepseek-v4-pro (a reasoning model) at max_tokens 1200. chatComplete
 * retries invalid JSON at max(3x, 4000) and then on a fallback model, and a live
 * run still came back "Expected ',' or '}' at position 1754" — truncated right at
 * the end of the fifth angle. Same shape as the gate truncation in FINDING 1: a
 * budget set by eye, against output nobody measured.
 *
 * Measures finish_reason and output tokens at the production budget. Read-only
 * apart from the LLM calls.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { chatComplete } from '@agent-crm/primitives';
import { getPolicy } from '@agent-crm/tools';

const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = Number(process.argv[2] ?? 3);

(async () => {
  const sb = createServerClient();
  const policy = await getPolicy(sb as any, WS);
  const w = (await sb.from('workspaces').select('about, icp').eq('id', WS).maybeSingle()).data as any;
  // Not the real prompt builder (it is not exported); close enough in size to
  // measure the SHAPE of the output, which is what the budget has to cover.
  const sys = 'You design a small set of WEB SEARCH ANGLES an AI sales agent runs, per prospect company. Return 3 to 5 angles. Each angle has id, label, query_template (must contain {entity}, up to 200 chars), domain_scope (own_site|news|open_web), recency_days, num_results, answers. Return JSON only: {"angles":[{"id","label","query_template","domain_scope","recency_days","num_results","answers"}]}';
  const user = `WORKSPACE:\n${(w?.about ?? '').slice(0, 2000)}\n\nProblems they solve:\n- ${(policy.drafter?.pain_points ?? []).join('\n- ')}\n\nTHE BRIEF:\n${(policy.research?.brief ?? []).map((q: any) => `  ${q.id} — ${q.question}`).join('\n')}`;

  for (const budget of [1200, 2400]) {
    const out: number[] = [];
    let bad = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await chatComplete({
        model: 'deepseek-v4-pro', max_tokens: budget,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      });
      const tokens = (r as any).usage?.output_tokens ?? (r as any).usage?.completion_tokens ?? -1;
      let ok = true;
      try { JSON.parse(r.text); } catch { ok = false; bad++; }
      out.push(tokens);
      console.log(`  budget=${budget} run${i + 1}: finish=${r.finish_reason} out_tokens=${tokens} chars=${r.text.length} json=${ok ? 'ok' : 'BROKEN'}`);
    }
    const max = Math.max(...out);
    console.log(`budget=${budget}: broken ${bad}/${RUNS}, max out_tokens ${max}, headroom ${max > 0 ? (budget / max).toFixed(1) + 'x' : 'unknown'}\n`);
  }
})();
