// #3 config: set Sudden's social_domains + exec-posts research guidance, then
// regenerate + persist the strategy so a social angle appears.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy, persistResearchStrategy } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const GUIDANCE = 'The best outreach trigger is something a specific person at the company said recently: a post, a conference talk, a podcast or interview by their streaming, engineering, or video leadership about delivery costs, CDN spend, scaling to more viewers, or launching in new regions. Prioritize finding that. Also keep covering what the company shipped and who they serve.';

async function main() {
  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const research = {
    ...((policy.research as Record<string, unknown>) ?? {}),
    guidance: GUIDANCE,
    social_domains: ['linkedin.com'],
  };
  const { error: upErr } = await sb.from('workspaces').update({ policy: { ...policy, research } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log('config written: social_domains=[linkedin.com], guidance set');

  const { angles, source, error: genErr } = await generateResearchStrategy(sb, WS);
  if (genErr) console.log('planner error:', genErr);
  console.log('source:', source);
  for (const a of angles) console.log(`  ${a.id} [${a.domain_scope}] recency=${a.recency_days ?? '-'} n=${a.num_results}: ${a.query_template}`);
  if (source === 'ai') {
    await persistResearchStrategy(sb, WS, angles);
    console.log('strategy persisted');
  } else {
    console.log('NOT persisting baseline — planner failed, config left for retry');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
