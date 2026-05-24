import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { chatComplete } from '@agent-crm/primitives';
import { listConnectors } from '@agent-crm/inngest/functions/sources/registry_meta';

export const runtime = 'nodejs';

const META_MODEL = 'deepseek/deepseek-v4-flash:free';

interface ParseReq {
  description: string;
  workspace_id?: string;  // optional — if present, the meta-agent gets the entity list and can pre-select watch_entities
}

interface DraftConfig {
  connector_type: string;
  name: string;
  config: Record<string, unknown>;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ParseReq | null;
  if (!body?.description?.trim()) {
    return NextResponse.json({ error: 'description required' }, { status: 400 });
  }
  // Build the connector summary for the meta-agent: type, label, description, full config_schema.
  const connectors = listConnectors();
  const connectorSummary = connectors.map((c) => ({
    type: c.type,
    label: c.label,
    description: c.description,
    config_fields: c.config_schema.fields.map((f) => ({
      name: f.name,
      label: f.label,
      kind: f.kind,
      required: f.required ?? false,
      help: f.help,
      default: f.default,
    })),
  }));

  // Optionally pull entity list so the meta-agent can suggest watch_entities.
  let entityContext = '';
  if (body.workspace_id) {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('entities')
      .select('id, name')
      .eq('workspace_id', body.workspace_id)
      .eq('kind', 'account')
      .order('name')
      .limit(200);
    if (!error && data && data.length) {
      const entityList = data.map((e) => `${e.name} (id=${e.id})`).join('\n');
      entityContext = `\n\nAvailable entities in this workspace (you may pre-select up to 10 for watch_entities if the user described specific companies):\n${entityList}`;
    }
  }

  const META_PROMPT = `You convert a user's plain-English description of a desired ingest source into a draft configuration row for an agent-native CRM.

Available connector types and their config schemas:
${JSON.stringify(connectorSummary, null, 2)}
${entityContext}

Output strictly JSON, no preamble:
{
  "connector_type": "<one of the types above>",
  "name": "<snake_case_label, max 50 chars>",
  "config": { /* a complete config object matching the picked connector_type's config_fields */ }
}

Rules — pick the connector_type that best matches the user's intent.

PRESETS (one-click, hardcoded source):
- "watch HN" / "Hacker News" / mentions of HN posts -> "hn"
- "YC companies" / "Y Combinator directory" / "scrape YC active companies" -> "yc"  (the COMPANY directory, not jobs)
- "GitHub" / "watch the org's releases" / "watch repos" -> "github"
- "Product Hunt" / "PH launches" -> "producthunt"

TOOLS (generic, user fills config):
- Specific RSS feed URL or known static feed (Substack /feed, blog RSS, simple HTML page) -> "web"
- SEARCH the open web (hiring discovery, news, competitor research, funding announcements, or any JS-hydrated site where RSS won't work) -> "exa"
- A specific REST/JSON API not covered by a preset (e.g. company's own webhook export, custom endpoint, niche API the user mentioned) -> "api_call"

Rule of thumb: prefer presets when a known source matches. Otherwise pick the tool: web for static URLs/RSS, exa for searches across the web, api_call for explicit API endpoints the user named.
- name: snake_case, descriptive, like "hn_ai_crm_mentions" or "yc_jobs_gtm_hires".
- For the web connector specifically:
  - intent: set to "discover" when the user wants to FIND new companies (hiring scans, "find startups doing X"). Set to "watch" when they're tracking signals on companies they already track. Set to "auto" when ambiguous.
  - watch_entities: only populate when intent="watch" and the user named specific companies present in the entity list above; else [].
  - roles: when the user names specific job roles ("Founding GTM, GTM Engineer, Growth, Automation Engineer"), put EACH role verbatim as an array entry. Don't normalize. Don't drop them.
  - keywords: any other free-form criteria the user mentioned that doesn't fit roles (e.g. "remote", "Series A", "San Francisco").
  - extraction_prompt: a one-line hint about what shape of items live on the page, if obvious. Example for jobs: "Find job listings. Each has a role title, company name, location, posted date."
  - url: extract from the description verbatim if a URL is given. If the user names a site without a full URL, build a plausible one from their wording.
- config: include every field the chosen connector understands. Add custom fields beyond the schema if the user mentions criteria the schema doesn't cover; the UI will render them as editable text.
- For batches (yc connector): convert "W25"/"S25" or "Winter 2025"/"Summer 2025" forms; emit them in the strings the user wrote.
- For string_array fields with no info, return [].
- For number fields with a default, use the default unless the user specified otherwise.

Shape-only examples below. Angle-bracket placeholders (<topic>, <role>, <company>, <vertical>, etc.) stand in for whatever terms the actual user description supplies — substitute them with the user's real values when emitting output. Do NOT echo angle-bracket placeholders back.

User: "watch HN for <topic> mentions"
Output: {"connector_type":"hn","name":"hn_<topic>_mentions","config":{"watch_entities":[],"keywords":["<topic>"],"since_hours":24,"min_points":0}}

User: "scrape YC <batch> <status> companies"
Output: {"connector_type":"yc","name":"yc_<batch>_<status>","config":{"batches":["<batch>"],"statuses":["<status>"],"industries":[],"max_per_run":200}}

User: "watch the <feed-or-newsletter-url> RSS"
Output: {"connector_type":"web","name":"<feed_slug>","config":{"url":"<feed-url>","intent":"watch","watch_entities":[],"roles":[],"keywords":[],"fetch_mode":"auto","since_hours":168,"extraction_prompt":""}}

User: "find <industry> companies hiring for <roles>"
Output: {"connector_type":"exa","name":"<industry>_<role-summary>_hires","config":{"query":"<industry> hiring <roles>","include_domains":[],"intent":"discover","watch_entities":[],"roles":["<role-1>","<role-2>"],"keywords":[],"num_results":25,"since_hours":168,"search_type":"auto"}}

User: "find <signal> in <vertical>"
Output: {"connector_type":"exa","name":"<vertical>_<signal-summary>","config":{"query":"<vertical> <signal>","include_domains":[],"intent":"discover","watch_entities":[],"roles":[],"keywords":["<signal>","<vertical>"],"num_results":25,"since_hours":168,"search_type":"auto"}}

User: "watch <company>'s GitHub for releases"
Output: {"connector_type":"github","name":"<company>_github_releases","config":{"watch_entities":[],"event_types":["ReleaseEvent","PublicEvent","CreateEvent","MemberEvent","ForkEvent"],"since_hours":24}}

`;

  let llm;
  try {
    llm = await chatComplete({
      model: META_MODEL,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: META_PROMPT },
        { role: 'user', content: body.description.trim() },
      ],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  let parsed: DraftConfig;
  try {
    parsed = JSON.parse(llm.text);
  } catch {
    return NextResponse.json({ error: `meta-agent returned non-JSON: ${llm.text.slice(0, 200)}` }, { status: 502 });
  }

  // Validate connector_type exists.
  if (!connectors.find((c) => c.type === parsed.connector_type)) {
    return NextResponse.json({ error: `unknown connector_type: ${parsed.connector_type}` }, { status: 502 });
  }

  // Auto-correct config to make it runnable on first execution. Saves the user
  // the "click create -> click run -> empty results" loop the audit found.
  const warnings = autoCorrectConfig(parsed);

  return NextResponse.json({
    parsed,
    warnings,
    meta_tokens: { input: llm.input_tokens, output: llm.output_tokens, cached_input: llm.cached_input_tokens },
  });
}

/**
 * Validation + auto-correction pass on the meta-agent's draft config. The meta-agent
 * sometimes emits configs that are semantically wrong (intent=watch + watch_entities=[]
 * for the web/api_call connectors, which then fail on first run). Catch and fix here
 * with warnings the UI can show to the user.
 */
function autoCorrectConfig(parsed: { connector_type: string; config: Record<string, unknown> }): string[] {
  const warnings: string[] = [];
  const cfg = parsed.config;

  // hn requires watch_entities. If empty, warn loudly — user must pick entities or the
  // source will fail every run. We don't auto-flip; HN keyword-only mode isn't supported.
  if (parsed.connector_type === 'hn') {
    const watch = (cfg.watch_entities as unknown[]) ?? [];
    if (!watch.length) {
      warnings.push('HN connector requires at least one watched entity. Pick entities in the form before saving, or this source will fail on every run.');
    }
  }

  // web/api_call connectors with intent=watch but empty watch_entities → flip to discover
  // (almost always what the user actually wanted when they didn't name companies).
  if (parsed.connector_type === 'web' || parsed.connector_type === 'api_call' || parsed.connector_type === 'exa') {
    const intent = cfg.intent as string | undefined;
    const watch = (cfg.watch_entities as unknown[]) ?? [];
    if (intent === 'watch' && watch.length === 0) {
      cfg.intent = 'discover';
      warnings.push(`Auto-flipped intent from "watch" to "discover" because watch_entities is empty. (watch mode requires entities; discover creates them per item.)`);
    }
  }

  return warnings;
}
