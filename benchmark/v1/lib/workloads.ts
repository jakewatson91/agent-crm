/**
 * v1 workloads: drafter, briefing, scoring.
 *
 * Each workload defines a SHARED rules block that every platform's prompt
 * uses verbatim. Per-platform prompts only differ in the tool-flow instructions
 * and the cite-id placeholder used in the output schema. This guarantees that
 * differences in token cost come from the platform's data shape and tool
 * pattern, not from prompt asymmetry.
 */

export type WorkloadName = 'draft' | 'brief' | 'score';

export interface Workload {
  name: WorkloadName;
  systemPromptAgentCrm: string;
  systemPromptHubSpot: string;
  systemPromptDayAi: string;
  systemPromptAttio: string;
  systemPromptTwenty: string;
  userPromptHubSpot: (account: string) => string;
  userPromptDayAi: (account: string) => string;
  userPromptAttio: (account: string) => string;
  userPromptTwenty: (account: string) => string;
}

// === Tool-flow instructions per platform ===

const agentCrmFlow = `You are given a projection object containing: account info, facts, contacts, signals, and last touch. Reason directly from the projection in one pass.`;

const hubspotFlow = `Use the HubSpot tools in this order:
  1. hubspot_get_company_by_name — fetch the company record
  2. hubspot_get_associated_contacts — fetch contacts at that company
  3. hubspot_get_recent_notes — fetch recent notes (past touches + facts) for context`;

const dayAiFlow = `Use the Day.ai SDK tools in this order:
  1. dayai_search_organization — find the organization record (returns org + relationships)
  2. dayai_get_contact — get full person record for the most senior contact
  3. dayai_search_notes — get recent notes (signals + past touches) for context`;

const attioFlow = `Use the Attio tools in this order:
  1. attio_search_company_by_name — find the Company record
  2. attio_get_company_people — fetch People records linked to that company
  3. attio_get_company_notes — fetch recent notes for context (signals + past touches)`;

const twentyFlow = `Use the Twenty CRM tools in this order:
  1. twenty_get_company — find the Company record by name (returns company + its People + its Notes in one nested GraphQL query)`;

// === Shared rules blocks per workload ===
// Same identical text across all platforms. The {{CITE_ID}} placeholder is
// replaced per-platform to reflect what each platform uses as a stable ID
// (UUID for agent-crm/Attio/Twenty, mixed objectId for Day.ai, etc.).

const DRAFT_OUTPUT = `Output strictly valid JSON, no preamble:
{"to": "<email>", "subject": "<subject>", "body": "<body>", "cites": ["<id>", ...]}

Rules:
- Pick the highest-seniority contact (CEO > CTO > COO > other; otherwise first contact).
- Subject < 60 chars.
- Body must reference ONE specific fact about the company AND the prior touch.
- Body 2-4 sentences. Casual, founder-to-founder tone. No "I hope this finds you well."
- Cite the fact and the prior touch you referenced.`;

const BRIEF_OUTPUT = `Output strictly valid JSON, no preamble:
{"contact_id": "<id>", "briefing": "<text>", "cites": ["<id>", ...]}

Briefing must cover (~100 words total):
1. Who they are (1 sentence)
2. What's new since the last touch (1-2 sentences referencing a specific recent fact)
3. What to ask about (1-2 sentences)
4. Any risks or red flags (if any; otherwise omit)

Be concise. Tactical, not generic. Cite the contact, the fact, and the prior touch you referenced.`;

const SCORE_OUTPUT = `Output strictly valid JSON, no preamble:
{"score": <0-10>, "reason": "<one sentence>", "cites": ["<id>", ...]}

Factors:
- Recency and strength of relevant signals (recent = higher)
- Match between facts and ICP (early-stage SaaS startups doing outbound)
- Time since last touch (very recent = lower priority unless big new signal; long gap = stale)
- Contact seniority (CEO/CTO available = higher; only ICs = lower)

A score of 10 = drop everything and reach out today. A score of 0 = don't bother. Cite the facts and signals you weighed.`;

// === Build platform prompts per workload ===

function buildPrompt(role: string, flow: string, output: string): string {
  return `You are ${role}.
For the named account, complete the task.

${flow}

${output}`;
}

const DRAFTER_ROLE = 'an outbound drafter agent';
const BRIEFER_ROLE = 'a pre-meeting briefing agent';
const SCORER_ROLE = 'an outreach prioritization agent';

const DRAFT: Workload = {
  name: 'draft',
  systemPromptAgentCrm: buildPrompt(DRAFTER_ROLE, agentCrmFlow, DRAFT_OUTPUT),
  systemPromptHubSpot: buildPrompt(DRAFTER_ROLE, hubspotFlow, DRAFT_OUTPUT),
  systemPromptDayAi: buildPrompt(DRAFTER_ROLE, dayAiFlow, DRAFT_OUTPUT),
  systemPromptAttio: buildPrompt(DRAFTER_ROLE, attioFlow, DRAFT_OUTPUT),
  systemPromptTwenty: buildPrompt(DRAFTER_ROLE, twentyFlow, DRAFT_OUTPUT),
  userPromptHubSpot: (account) => `Account: ${account}\n\nDraft.`,
  userPromptDayAi: (account) => `Account: ${account}\n\nDraft.`,
  userPromptAttio: (account) => `Account: ${account}\n\nDraft.`,
  userPromptTwenty: (account) => `Account: ${account}\n\nDraft.`,
};

const BRIEF: Workload = {
  name: 'brief',
  systemPromptAgentCrm: buildPrompt(BRIEFER_ROLE, agentCrmFlow, BRIEF_OUTPUT),
  systemPromptHubSpot: buildPrompt(BRIEFER_ROLE, hubspotFlow, BRIEF_OUTPUT),
  systemPromptDayAi: buildPrompt(BRIEFER_ROLE, dayAiFlow, BRIEF_OUTPUT),
  systemPromptAttio: buildPrompt(BRIEFER_ROLE, attioFlow, BRIEF_OUTPUT),
  systemPromptTwenty: buildPrompt(BRIEFER_ROLE, twentyFlow, BRIEF_OUTPUT),
  userPromptHubSpot: (account) => `Account: ${account}\n\nProduce the briefing.`,
  userPromptDayAi: (account) => `Account: ${account}\n\nProduce the briefing.`,
  userPromptAttio: (account) => `Account: ${account}\n\nProduce the briefing.`,
  userPromptTwenty: (account) => `Account: ${account}\n\nProduce the briefing.`,
};

const SCORE: Workload = {
  name: 'score',
  systemPromptAgentCrm: buildPrompt(SCORER_ROLE, agentCrmFlow, SCORE_OUTPUT),
  systemPromptHubSpot: buildPrompt(SCORER_ROLE, hubspotFlow, SCORE_OUTPUT),
  systemPromptDayAi: buildPrompt(SCORER_ROLE, dayAiFlow, SCORE_OUTPUT),
  systemPromptAttio: buildPrompt(SCORER_ROLE, attioFlow, SCORE_OUTPUT),
  systemPromptTwenty: buildPrompt(SCORER_ROLE, twentyFlow, SCORE_OUTPUT),
  userPromptHubSpot: (account) => `Account: ${account}\n\nScore.`,
  userPromptDayAi: (account) => `Account: ${account}\n\nScore.`,
  userPromptAttio: (account) => `Account: ${account}\n\nScore.`,
  userPromptTwenty: (account) => `Account: ${account}\n\nScore.`,
};

export const WORKLOADS: Record<WorkloadName, Workload> = { draft: DRAFT, brief: BRIEF, score: SCORE };
