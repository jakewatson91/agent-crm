/**
 * One-shot setup for the dog-food workspace:
 *   1. Populate workspaces.knowledge_base with the real pain → angle map.
 *   2. Create 5 Exa intent-search sources (will fail-clean until EXA_API_KEY is set).
 *   3. Create 3 RSS sources for known good feeds (TechCrunch, Indie Hackers, Substack).
 *
 * Idempotent on knowledge_base (overwrites). Source create is not idempotent — run once.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const KB = `- TRIGGERS: "token bloat", "agent burns my OpenAI budget", "context window cost", "agents read too much"
  ANGLE: agent-native projection sized for agents not humans. 1.28x token efficiency in head-to-head vs reading raw rows from HubSpot. Cached prefixes hit ~90% on repeated runs.

- TRIGGERS: "agents overwriting each other", "data silently disappears", "race conditions on shared accounts"
  ANGLE: append-only event log + content-addressed facts. In a 50-parallel-writer benchmark, agent-crm persisted 50/50 records; HubSpot persisted 2/50 (96% data loss, all PATCHes returned 200 OK).

- TRIGGERS: "agent hallucinates customer details", "can't trust what the bot says", "no audit trail", "compliance review of AI outputs"
  ANGLE: every claim carries a fact_id with a source-event chain. Recipient can verify any sentence in a draft back to the originating signal, the actor that asserted it, and the prompt hash that produced it.

- TRIGGERS: "managing GTM with 1-2 people and AI", "lean team plus agents", "no time to babysit dashboards", "everyone says agents but my workflow is still manual"
  ANGLE: humans only see info when policy says so — gates inbox, not dashboards. The default home screen is empty when the system is healthy.

- TRIGGERS: "Salesforce/HubSpot wasn't built for AI", "bolt-on AI on legacy CRM", "AI on top of tables and cards", "Rox/Day/Breeze are still fundamentally row-based"
  ANGLE: ground-up architecture for the agent as primary user. Events as source of truth, facts as atomic claims, projections sized per query. Humans get a feed; agents get a tool surface.

- TRIGGERS: "I want to replay an agent decision", "why did the agent do that yesterday", "audit what the AI agreed to last week"
  ANGLE: replay_to(timestamp) reconstructs full state in one RPC. Pin an agent run to a knowledge snapshot, rerun against any past state. HubSpot has no equivalent.

- TRIGGERS: "I'm a solo founder doing outbound", "scaling sales without hiring", "AI SDR that doesn't suck"
  ANGLE: drafter agents that cite real facts. The email goes out only after a critic passes (suppression list, banned phrases, rate cap). You review a gates inbox; you don't write copy.`;

const RSS_SOURCES = [
  {
    name: 'techcrunch_startups_rss',
    url: 'https://techcrunch.com/category/startups/feed/',
    description: 'TechCrunch startups feed — funding rounds, launches, layoffs',
    keywords: ['Series A', 'Series B', 'raised', 'launches', 'AI', 'GTM', 'sales', 'CRM'],
  },
  {
    name: 'indie_hackers_main',
    url: 'https://www.indiehackers.com/feed.xml',
    description: 'Indie Hackers community feed',
    keywords: ['CRM', 'sales', 'outbound', 'AI', 'agents', 'GTM', 'token'],
  },
  {
    name: 'lennys_newsletter',
    url: 'https://www.lennysnewsletter.com/feed',
    description: "Lenny's Newsletter — product/GTM",
    keywords: ['GTM', 'sales', 'CRM', 'AI agents', 'pipeline', 'outbound'],
  },
];

const EXA_SOURCES = [
  {
    name: 'exa_hubspot_salesforce_ai_complaints',
    query: 'founders complaining about HubSpot or Salesforce limitations with AI agents',
    keywords: ['HubSpot', 'Salesforce', 'frustrated', 'limited', 'broken', 'AI'],
    include_domains: [],
  },
  {
    name: 'exa_lean_gtm_ai_teams',
    query: 'GTM with 1-2 people running AI agents instead of hiring SDRs',
    keywords: ['SDR', 'BDR', 'AI agents', 'lean team', 'solo founder', 'replace'],
    include_domains: [],
  },
  {
    name: 'exa_token_cost_complaints',
    query: 'AI agent token cost OpenAI bill burn through context window CRM',
    keywords: ['token', 'cost', 'OpenAI', 'budget', 'context window', 'expensive'],
    include_domains: [],
  },
  {
    name: 'exa_crm_evals_for_ai',
    query: 'evaluating CRM for AI workflows: HubSpot vs Salesforce vs Day vs Rox vs alternatives',
    keywords: ['evaluation', 'comparison', 'alternative', 'CRM', 'AI'],
    include_domains: [],
  },
  {
    name: 'exa_agent_outbound_threads',
    query: 'building outbound automation with AI agents bottlenecks data quality',
    keywords: ['outbound', 'automation', 'AI agent', 'data quality', 'pipeline'],
    include_domains: [],
  },
];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id, name').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;

  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)}...)\n`);

  // 1. Populate knowledge base
  console.log('1. populating knowledge_base...');
  const upd = await sb.from('workspaces').update({ knowledge_base: KB }).eq('id', WS);
  if (upd.error) throw upd.error;
  console.log(`   ✓ ${KB.length} chars\n`);

  // 2. Create RSS sources
  console.log('2. creating RSS sources...');
  for (const s of RSS_SOURCES) {
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

  // 3. Create Exa intent searches
  console.log('3. creating Exa intent-search sources...');
  for (const s of EXA_SOURCES) {
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
