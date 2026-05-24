/**
 * Vertical-neutral seeder for demo workspaces.
 *
 *   tsx scripts/seed_demo_workspace.ts --profile=dogfood
 *
 * The script itself contains no vertical content — KB entries, source URLs,
 * workspace name patterns all come from a profile module under scripts/seed/.
 * To seed a different vertical, add scripts/seed/<name>.ts implementing
 * SeedProfile and pass --profile=<name>.
 *
 * This is NOT the new-customer onboarding path. Customers configure via the
 * wizard / settings UI. This script exists for demo / dogfood instances only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { SeedProfile } from './seed/types.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let profile: string | undefined;
  let workspaceName: string | undefined;
  for (const a of args) {
    if (a.startsWith('--profile=')) profile = a.slice('--profile='.length);
    else if (a.startsWith('--workspace=')) workspaceName = a.slice('--workspace='.length);
  }
  if (!profile) {
    console.error('usage: tsx scripts/seed_demo_workspace.ts --profile=<name> [--workspace="<name pattern>"]');
    process.exit(1);
  }
  return { profile, workspaceName };
}

async function loadProfile(name: string): Promise<SeedProfile> {
  // Dynamic import so profiles don't all get bundled when only one is used.
  const mod = await import(`./seed/${name}.js`).catch(async () => {
    return await import(`./seed/${name}.ts`);
  });
  const p = (mod.default ?? mod) as SeedProfile;
  if (!p?.workspace_name_pattern || !p.knowledge_base || !p.rss_sources || !p.exa_sources) {
    throw new Error(`profile ${name} is missing required fields`);
  }
  return p;
}

async function main() {
  const { profile: profileName, workspaceName } = parseArgs();
  const profile = await loadProfile(profileName);
  const pattern = workspaceName ?? profile.workspace_name_pattern;

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces')
    .select('id, name')
    .ilike('name', pattern)
    .order('created_at', { ascending: false })
    .limit(1).single();
  if (ws.error || !ws.data) throw new Error(`no workspace matching pattern: ${pattern}`);
  const WS = ws.data.id as string;
  console.log(`profile: ${profileName}`);
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)}...)\n`);

  console.log('1. populating knowledge_base...');
  const upd = await sb.from('workspaces').update({ knowledge_base: profile.knowledge_base }).eq('id', WS);
  if (upd.error) throw upd.error;
  console.log(`   ✓ ${profile.knowledge_base.length} chars\n`);

  console.log('2. creating RSS sources...');
  for (const s of profile.rss_sources) {
    const res = await fetch('http://localhost:3000/api/sources/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: WS,
        connector_type: 'web',
        name: s.name,
        config: {
          url: s.url,
          intent: 'discover',
          watch_entities: [],
          roles: [],
          keywords: s.keywords,
          fetch_mode: 'auto',
          since_hours: 168,
          extraction_prompt: s.description,
        },
      }),
    });
    const j = await res.json();
    console.log(`   ${j.ok ? '✓' : '✗'} ${s.name}: ${j.source_id ?? j.error}`);
  }
  console.log();

  console.log('3. creating Exa intent-search sources...');
  for (const s of profile.exa_sources) {
    const res = await fetch('http://localhost:3000/api/sources/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: WS,
        connector_type: 'exa',
        name: s.name,
        config: {
          query: s.query,
          intent: 'discover',
          watch_entities: [],
          include_domains: s.include_domains,
          exclude_domains: [],
          roles: [],
          keywords: s.keywords,
          num_results: 25,
          since_hours: 168,
          search_type: 'auto',
        },
      }),
    });
    const j = await res.json();
    console.log(`   ${j.ok ? '✓' : '✗'} ${s.name}: ${j.source_id ?? j.error}`);
  }

  console.log('\ndone. visit /workspace/<ws>/sources to inspect.');
  console.log('Exa sources fail-clean until EXA_API_KEY is set in .env.local — set it and click "run now" to start collecting.');
}
main().catch((e) => { console.error(e); process.exit(1); });
