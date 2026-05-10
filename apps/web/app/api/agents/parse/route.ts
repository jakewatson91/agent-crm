import { NextResponse } from 'next/server';
import { chatComplete } from '@agent-crm/primitives';
import { listConnectors } from '@agent-crm/inngest/functions/sources/registry';

export const runtime = 'nodejs';

const META_MODEL = 'gpt-4o-mini';

function buildMetaPrompt(): string {
  // Inject the actual signal_source values each connector emits, so the meta-agent
  // doesn't invent variants like "yc_directory" when the connector emits "yc".
  const sources = listConnectors().map((c) => `  ${c.emits_signal_source} (from ${c.label})`).join('\n');
  return BASE_PROMPT.replace('{SIGNAL_SOURCES}', sources);
}

const BASE_PROMPT = `You convert a user's plain-English description of an agent into a subscription row for an agent-native CRM.

Output strictly JSON, no preamble:
{
  "name": "<snake_case_label, max 50 chars>",
  "owner_id": "claims_<distinctive_noun_phrase>",
  "semantic_query": "<one clear sentence; preserve the user's specific terminology>",
  "structured_filter": <jsonb object — see rules>,
  "threshold": <0.30–0.60>,
  "action_on_match": "agent.run",
  "agent_behavior": "claim_poster" | "drafter" | "enricher"
}

Rules for agent_behavior:
- "drafter" — when the user describes producing outbound emails, drafts, sequences, or "writes" / "drafts" / "sends" outreach. Output is a touch_draft post (email subject + body).
- "enricher" — when the user describes EXTRACTING facts from incoming signals: "extract facts", "build out account profiles", "enrich entities from signals", "pull stack/funding/role info from news". Output is a list of assert_fact calls plus a summary post. This is what fills entities with citable ground truth over time.
- "claim_poster" (default) — for everything else. Posts a 1-2 sentence claim summarizing the signal.

Do NOT output a model field. Model selection is the user's responsibility — they enter the model id directly in the form.

Rules for owner_id:
- MUST start with "claims_" and be lowercase snake_case.
- MUST include the distinctive nouns from the user's description.
- WRONG: user says "watch X posts from ICP companies" -> "claims_icp_companies" (drops "x_posts")
- RIGHT: user says "watch X posts from ICP companies" -> "claims_x_posts_from_icp_companies"
- WRONG: user says "fundraises in fintech" -> "claims_fintech" (drops "fundraises")
- RIGHT: user says "fundraises in fintech" -> "claims_fintech_fundraises"

Rules for structured_filter:
- Keys are FREEFORM. Pick whichever key/value pairs an ingest worker would actually tag a signal of this type with.
- VALID signal_source values (use these EXACTLY — these are the strings the connectors actually emit):
{SIGNAL_SOURCES}
- For sources NOT yet in this list (X/Twitter, LinkedIn, Reddit, blog RSS via web connector, etc.):
- For sources NOT in that list (X/Twitter, LinkedIn, Reddit, Slack, Discord, blog RSS, etc.):
    INVENT a sensible signal_source value matching how a future worker would tag it.
    Examples: "x" (for X/Twitter), "linkedin", "reddit", "rss", "discord", "youtube"
- DO NOT force-fit to the known list. It's better to invent a new value than to pick the wrong listed one.
- If the description has no clear signal source at all, return structured_filter: {} — the subscription matches semantically only.
- Include other keys when the description gives them: industry, role, region, persona, company_size, funding_stage, signal_type.
- DO NOT emit empty objects as values: {industry: {}} is wrong; just omit the key.

Rules for semantic_query:
- Preserve the user's specific terminology. If they said "X posts," keep "X posts" — don't generalize to "social media posts."
- One clear sentence. Natural language, not jargon.

Rules for threshold:
- Default 0.40.
- Lower (0.30) when the description is broad ("any GTM news").
- Higher (0.55) when the description is narrow ("only Series B rounds at fintechs in Q2").

Examples:

User: "watch X posts from companies in our ICP"
Output: {"name":"x_posts_from_icp_companies","owner_id":"claims_x_posts_from_icp_companies","semantic_query":"X posts mentioning or written by companies that match our ICP","structured_filter":{"signal_source":"x"},"threshold":0.40,"action_on_match":"agent.run","agent_behavior":"claim_poster"}

User: "draft outbound emails for high-fit YC accounts"
Output: {"name":"yc_outbound_drafter","owner_id":"claims_yc_outbound_drafts","semantic_query":"high-fit YC accounts ready for outbound","structured_filter":{"signal_source":"yc"},"threshold":0.45,"action_on_match":"agent.run","agent_behavior":"drafter"}

User: "watch for any GTM news"
Output: {"name":"any_gtm_news","owner_id":"claims_gtm_news","semantic_query":"general GTM news from any source","structured_filter":{},"threshold":0.30,"action_on_match":"agent.run"}
`;

interface ParseReq {
  description: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ParseReq | null;
  if (!body?.description?.trim()) {
    return NextResponse.json({ error: 'description required' }, { status: 400 });
  }
  let llm;
  try {
    llm = await chatComplete({
      model: META_MODEL,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildMetaPrompt() },
        { role: 'user', content: body.description.trim() },
      ],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(llm.text);
  } catch {
    return NextResponse.json({ error: `meta-agent returned non-JSON: ${llm.text.slice(0, 200)}` }, { status: 502 });
  }
  return NextResponse.json({
    parsed,
    meta_tokens: { input: llm.input_tokens, output: llm.output_tokens, cached_input: llm.cached_input_tokens },
  });
}
