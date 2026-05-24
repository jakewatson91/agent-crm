/**
 * Seed profile for the agent-crm dogfood workspace.
 *
 * This file IS the vertical-specific content — knowledge base entries and
 * source list for "agent-crm selling agent-crm" as the test case (see
 * project_test_case_dogfood memory rule). Other verticals (real estate,
 * fintech, etc.) live in their own profile module — DO NOT generalize
 * this one or add cross-vertical defaults to it.
 *
 * Consumed by scripts/seed_demo_workspace.ts.
 */

import type { SeedProfile } from './types.js';

const knowledge_base = `- TRIGGERS: "token bloat", "agent burns my OpenAI budget", "context window cost", "agents read too much"
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

const rss_sources = [
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

const exa_sources = [
  {
    name: 'exa_hubspot_salesforce_ai_complaints',
    query: 'founders complaining about HubSpot or Salesforce limitations with AI agents',
    keywords: ['HubSpot', 'Salesforce', 'frustrated', 'limited', 'broken', 'AI'],
    include_domains: [] as string[],
  },
  {
    name: 'exa_lean_gtm_ai_teams',
    query: 'GTM with 1-2 people running AI agents instead of hiring SDRs',
    keywords: ['SDR', 'BDR', 'AI agents', 'lean team', 'solo founder', 'replace'],
    include_domains: [] as string[],
  },
  {
    name: 'exa_token_cost_complaints',
    query: 'AI agent token cost OpenAI bill burn through context window CRM',
    keywords: ['token', 'cost', 'OpenAI', 'budget', 'context window', 'expensive'],
    include_domains: [] as string[],
  },
  {
    name: 'exa_crm_evals_for_ai',
    query: 'evaluating CRM for AI workflows: HubSpot vs Salesforce vs Day vs Rox vs alternatives',
    keywords: ['evaluation', 'comparison', 'alternative', 'CRM', 'AI'],
    include_domains: [] as string[],
  },
  {
    name: 'exa_agent_outbound_threads',
    query: 'building outbound automation with AI agents bottlenecks data quality',
    keywords: ['outbound', 'automation', 'AI agent', 'data quality', 'pipeline'],
    include_domains: [] as string[],
  },
];

const profile: SeedProfile = {
  workspace_name_pattern: 'demo · agent-crm%',
  knowledge_base,
  rss_sources,
  exa_sources,
};

export default profile;
