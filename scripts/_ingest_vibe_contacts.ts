import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { linkContactByProspectId, scoreAndAssert } from '@agent-crm/tools';

// Names-first contacts pulled FREE from Vibe/Explorium discovery preview (no email).
// Gathered via match-business + fetch-entities (founder/c-suite) on top-fit accounts.
// The production connector (next pass) calls Explorium's HTTP API directly; for this
// test the agent gathered rows via MCP and this script exercises the write path.
const ROWS = [
  { domain: 'afterquery.com',    name: 'Spencer Mateega',         role: 'Co-founder, CEO',                    linkedin_url: 'linkedin.com/in/ACoAAC0y4aEBqk2QuqzPuAdlTj68cXoNM_A9WQk', prospect_id: '70f5437fc214b6b1a9e2cd891c0522c3a98759b9' },
  { domain: 'videogen.io',       name: 'David Grossman',          role: 'Co-founder & CTO',                   linkedin_url: 'linkedin.com/in/ACoAADcTyCQBzq-qVPTCDvFteghEqRDbxErTRdI', prospect_id: '79cf33f1116c4418f36b3423bf744fabc294b302' },
  { domain: 'getauctor.com',     name: 'Sky Ng-thow-hing',        role: 'Co-founder & CPO',                   linkedin_url: 'linkedin.com/in/ACoAAC1vfBUBlajWQbHrIngVr2FYV0DBBfP3vJ8', prospect_id: 'b59fc0f3defa972ca86264a9ced7551fe26108eb' },
  { domain: 'hellosunset.com',   name: 'Stephen Walter',          role: 'CEO',                                linkedin_url: 'linkedin.com/in/ACoAADsKzKUBHzY7wPW0c3fIvaGGKrS3il8iOGs', prospect_id: '229abd17000d5a7eff8518b83362a44641a24001' },
  { domain: '14.ai',             name: 'Marie Schneegans',        role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAAAsshogBexUQA9X3Oyc46tuGMqiuT7a-fC0', prospect_id: 'abd627706ce53ac289283236c09b06966201758b' },
  { domain: 'gofinto.com',       name: 'Linus Boehm',             role: 'Co-founder & CTO',                   linkedin_url: 'linkedin.com/in/ACoAAB8FxOEBO_WUVeRqOCkwx2630NmkzLdGwHo', prospect_id: '2cc9b71ba05e2b0fa69336346856ddaa4958f62c' },
  { domain: 'a0.dev',            name: 'Seth Setse',              role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAACl_f8wBGuwjSbeZa9slSCIhdwwO9cnWkrg', prospect_id: '125df524066b391cef8e02112247580f1484a5af' },
  { domain: 'eloquentai.co',     name: 'Burce Bulut Ozan',        role: 'COO',                                linkedin_url: 'linkedin.com/in/ACoAAADkhIwBRpA_0VcZ-0nScGcSQREZIB2MLQs', prospect_id: '4d864cec2e94e52c06925f8b977a2690fa1dd314' },
  { domain: 'abundant.ai',       name: 'Jesse Hu',                role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAAA0WGPwBC5-H483e87fcimLf6ldTzXVaE2E', prospect_id: '356698091a48714ccfd4f91563b4f56ae42d8cbe' },
  { domain: 'anara.com',         name: 'Naveed Janmohamed',       role: 'Founder',                            linkedin_url: 'linkedin.com/in/ACoAABHszJgBUa7ODU4o04c_Rjjv_-9WpHgh7ew', prospect_id: '99b2efe2fe0d068d944f76ed7507c63c235058da' },
  { domain: 'ambral.com',        name: 'Sam Brickman',            role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAACEnTyYBpDCWosJuq4Y93HQqzG03nVIonmM', prospect_id: '6009887aa18a588f6272972c33cce1984d3fb468' },
  { domain: 'archil.com',        name: 'Reagan Matthews',         role: 'Chief engineer',                     linkedin_url: 'linkedin.com/in/ACoAACL6V90BfVnbPjsoVPYcu5HRXsqjFYS0GQA', prospect_id: '7bbc6f1658643dfa860252c5a7bc45590556bd53' },
  { domain: 'arva.ai',          name: 'Rhim Shah',               role: 'Co-founder & CEO',                   linkedin_url: 'linkedin.com/in/ACoAACUu-wYBM3pUpizvpZ0TRufPvKchjO0raAw', prospect_id: 'faa34e5c8e58e4bd3fe7178be812482d7aa9e19c' },
  { domain: 'blaxel.ai',        name: 'Paul Sinai',              role: 'Co-founder & CEO',                   linkedin_url: 'linkedin.com/in/ACoAABIpcSEBYhSoY6ydokqJcH5_o11fVvEsdu0', prospect_id: '3cf07fcee3ccb9a26a46cc6595e27e7da3c0c2e1' },
  { domain: 'asteroid.ai',      name: 'Joe Hewett',              role: 'Founder',                            linkedin_url: 'linkedin.com/in/ACoAACZLB0oBJ8yPUI-L0WQn8B_jTqQdTAMyj9Q', prospect_id: '98f44e93dd0552dc5e4419b4cec0d338d0a780bf' },
  { domain: 'autosana.ai',      name: 'Yuvan Sundrani',          role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAADLzBE4BWVZslKubTaVD8_Y4US3PxWJNiXg', prospect_id: 'b94aa7d25931d1d701263a348689aa156cf256b6' },
  { domain: 'bravi.app',        name: 'Pierre-habte Nouvellon',  role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAABvTKKoBbjVXQGqjX_nmS7Atx9J4uKnqEM4', prospect_id: '5cf82b0a93af8d2fad9f92bad2ca341b828c80ad' },
  { domain: 'usecentralize.com', name: 'William Wang',            role: 'Co-founder',                         linkedin_url: 'linkedin.com/in/ACoAABpZoegBIBkilXrs9E7TuaOGdM5rMG6FbYE', prospect_id: 'd962130f994469f6232e367867ff32ee23297c45' },
  { domain: 'capitol.ai',       name: 'Thomas H.',               role: 'Co-founder & CTO',                   linkedin_url: 'linkedin.com/in/ACoAAACQTEwBhwV37ej1oxNq3vA2ZgPZglRJvqc', prospect_id: '3cc3270b9cec9b97d99e190b20c628a72c7fb1f2' },
  { domain: 'cartage.ai',       name: 'Josh Lampen',             role: 'Co-founder, CTO',                    linkedin_url: 'linkedin.com/in/ACoAABhv7M8BV7vj9tWgfITIcCKeppMIcuNdP10', prospect_id: '23caef7d4780accdd1d226285d313bd187f72a03' },
  { domain: 'coval.dev',        name: 'Rob Young',               role: 'Founding designer & head of design', linkedin_url: 'linkedin.com/in/ACoAAABZhrUBX3zqLKVp1GX2wKQ_WHheP81sm4M', prospect_id: '0bec0ad72a3b519c8b0fbfe09138fc2caa5b351d' },
  { domain: 'joincarma.com',    name: 'Suleyman Alasgarli',      role: 'Chief growth officer and founder',   linkedin_url: 'linkedin.com/in/ACoAACN9pZ0BvHorr67sHW8_BoMyzmPRpuHk0Nk', prospect_id: '6746e2af7b8cf82677d169cfbb614d764971c541' },
];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const byDomain = new Map<string, { id: string; name: string }>();
  for (const e of ents) { const d = e.attributes?.domain; if (d) byDomain.set(String(d).toLowerCase(), { id: e.id, name: e.name }); }

  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'source:vibe:explorium' };
  let created = 0, existed = 0, skipped = 0;
  for (const r of ROWS) {
    const ent = byDomain.get(r.domain);
    if (!ent) { console.log(`✗ ${r.domain} — no entity, skip`); skipped++; continue; }
    const res = await linkContactByProspectId(sb, actor, { account_entity_id: ent.id, name: r.name, role: r.role, linkedin_url: r.linkedin_url, prospect_id: r.prospect_id });
    // New facts arrived on this contact -> score it (skip-stale guard makes re-runs cheap).
    if (res.created) await scoreAndAssert(sb, actor, res.contact_entity_id);
    console.log(`  ${res.created ? 'CREATED' : 'exists '} ${r.name.padEnd(22).slice(0,22)} ${r.role.padEnd(26).slice(0,26)} @ ${ent.name}`);
    if (res.created) created++; else existed++;
  }
  console.log(`\ncreated ${created} | existed ${existed} | skipped ${skipped} | 0 email credits spent`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
