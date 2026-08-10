// Undoes the social_domains half of _cfg_sudden_social.ts.
//
// A linkedin.com-restricted COMPANY search cannot work. buildAngleRequest sends
// include_text: [entity_name] on the social scope, and the most common page on
// linkedin.com containing a company's name is an employee's profile card, so the
// search is structurally guaranteed to return profiles. Measured 2026-08-10:
// the linkedin_leadership angle fetched 183 pages and kept 0, and 170 of 213
// sampled drops were linkedin.com/in/ profile URLs.
//
// Clearing the host makes the scope inert (buildAngleRequest returns null) and
// stops the planner being handed socialScopeAddendum, which orders exactly one
// social angle. research.guidance is left alone on purpose: talks, podcasts and
// interviews by their video leadership are exactly what an open_web angle should
// chase, and that is where the one good technical_leader fact came from (an SVG
// Summit talk).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const research = { ...((policy.research as Record<string, unknown>) ?? {}), social_domains: [] };
  const { error: upErr } = await sb.from('workspaces').update({ policy: { ...policy, research } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log('social_domains cleared -> []');

  const { angles, source, error: genErr } = await generateResearchStrategy(sb, WS);
  console.log('\nDRY RUN (not persisted). source:', source, '| error:', genErr ?? 'none');
  for (const a of angles) {
    console.log(`  ${a.id} [${a.domain_scope}] answers=${a.answers ?? '-'} recency=${a.recency_days ?? '-'}: ${a.query_template}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
