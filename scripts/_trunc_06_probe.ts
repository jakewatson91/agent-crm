/**
 * Live A/B on the scorer's real prompt shape: the old 350 ceiling vs the new one.
 * Costs a handful of cents. Three runs per arm, because one pair is not readable.
 *
 * Result, 3 runs each on ViX (40 facts, 3978 chars of fact block):
 *
 *   cap 350    11813ms out=710    3651ms out=313    24836ms out=2221
 *   cap 4000   11880ms out=1199  15679ms out=1689    4657ms out=330
 *
 * READ IT ON output_tokens, NOT ON WALL TIME. The same prompt produced between
 * 313 and 2221 output tokens across runs, and latency tracks how much the model
 * decided to reason far more strongly than it tracks the number of calls, so a
 * three-run latency comparison says nothing. A single pair suggested the new
 * ceiling was 2.7x faster; three runs show that was sampling noise.
 *
 * What the numbers do settle: output above the cap can only come from
 * chatComplete's retry, since the cap is what the provider is given. Two of
 * three runs at 350 exceeded it. Three of three at 4000 fit in one call, the
 * largest reaching 1689. That matches the 30-day production figure of 2286
 * retries in 2295 scoring runs.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace, resolveMaxOutputTokens } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

(async () => {
  // A real fact-heavy account, the shape that drives the failures.
  const { data: ents } = await sb.from('entities').select('id,name').eq('workspace_id', WS).eq('name', 'ViX').limit(1);
  const ent = ents?.[0];
  if (!ent) { console.log('no entity'); return; }
  const { data: facts } = await sb.from('facts')
    .select('predicate,object_text,confidence').eq('subject_entity', ent.id).is('supersedes', null)
    .order('observed_at', { ascending: false }).limit(40);
  const block = (facts ?? []).map((f: any) => `  ${f.predicate}=${f.object_text} (${f.confidence})`).join('\n');
  console.log(`entity ${ent.name}: ${facts?.length ?? 0} facts, ${block.length} chars\n`);

  const sys = 'Score this account 0..1 on three rubric dimensions. Return JSON only: {"industry_match":n,"stage_match":n,"signal_strength":n,"reasoning":"one sentence"}';
  const user = `ACCOUNT: ${ent.name}\n\nFACTS (predicate=value, conf):\n${block}\n\nScore this account on the three rubric dimensions.`;

  for (const cap of [350, 350, 350, resolveMaxOutputTokens({}, 'scoring'), resolveMaxOutputTokens({}, 'scoring'), resolveMaxOutputTokens({}, 'scoring')]) {
    const t0 = Date.now();
    try {
      const r = await chatCompleteForWorkspace(sb as any, WS, {
        model: 'deepseek-v4-flash', behavior: 'scoring', max_tokens: cap,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      } as any);
      const ms = Date.now() - t0;
      let valid = true; try { JSON.parse(r.text); } catch { valid = false; }
      console.log(`max_tokens=${String(cap).padStart(5)}  ${String(ms).padStart(6)}ms  out=${String(r.output_tokens).padStart(5)}  in=${String(r.input_tokens).padStart(6)}  model=${r.model}  validJSON=${valid}`);
      console.log(`   ${(r.text ?? '').replace(/\s+/g,' ').slice(0,120)}`);
    } catch (e: any) {
      console.log(`max_tokens=${cap}  ERROR ${String(e?.message).slice(0,200)}`);
    }
  }
})();
