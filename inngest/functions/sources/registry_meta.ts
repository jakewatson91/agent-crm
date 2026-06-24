/**
 * Metadata-only entry point for the connector registry.
 *
 * Importing this file does NOT pull in any connector implementation, so routes
 * that just need to render the form / list available connectors don't pay the
 * cost of compiling the connector graph (which transitively imports
 * `@agent-crm/tools`, openai, supabase, etc.).
 *
 * `registry.ts` re-exports the same metadata alongside the runtime connectors.
 * The connector files import their `meta` from this file (single source of truth).
 */
import type { ConnectorMeta } from './types.js';

export const apiCallMeta: ConnectorMeta = {
  type: 'api_call',
  label: 'Custom API call',
  description: 'Build any HTTP request from scratch. URL, method, headers, body, JSON path for items. Use when no preset fits.',
  category: 'tool',
  emits_signal_source: 'api_call',
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      { name: 'url', label: 'URL', kind: 'text', required: true,
        help: 'Full URL including query string. e.g. https://api.example.com/v1/jobs?role=GTM' },
      { name: 'method', label: 'Method', kind: 'text', default: 'GET' },
      { name: 'headers', label: 'Headers (JSON)', kind: 'textarea',
        help: 'JSON object. Use "Bearer ${env:MY_API_KEY}" to interpolate env vars at runtime.' },
      { name: 'body', label: 'Request body (string or JSON)', kind: 'textarea',
        help: 'Optional. For POST/PUT.' },
      { name: 'items_path', label: 'Items path (dot notation)', kind: 'text',
        help: 'Where the array of items lives in the response. e.g. "data.results" or "hits". Empty = response is the array.' },
      { name: 'id_field', label: 'ID field per item', kind: 'text', default: 'id',
        help: 'Used for dedup across runs.' },
      { name: 'title_field', label: 'Title field per item', kind: 'text', default: 'title',
        help: 'Becomes part of the signal body.' },
      { name: 'body_field', label: 'Body field per item', kind: 'text', default: 'description',
        help: 'Concatenated into the signal body for embedding.' },
      { name: 'date_field', label: 'Date field per item', kind: 'text', default: 'created_at',
        help: 'Used to filter items by since_hours.' },
      { name: 'intent', label: 'Intent', kind: 'text', default: 'auto',
        help: '"watch" filters to known entities. "discover" creates entities per item. "auto" picks based on watch_entities.' },
      { name: 'watch_entities', label: 'Entities to watch (watch mode)', kind: 'entity_picker_multi' },
      { name: 'match_fields', label: 'Fields to search for entity match (watch mode)', kind: 'string_array',
        help: 'Default ["title","name","description","body","content"]. Specify per-item field names to scan for entity aliases.' },
      { name: 'company_field', label: 'Company name field (discover mode)', kind: 'text',
        help: 'Dot path to the company name on each item. e.g. "company.name" or "employer".' },
      { name: 'domain_field', label: 'Company domain field (discover mode)', kind: 'text',
        help: 'Optional. Dot path to a website/domain on each item, used for entity dedup.' },
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 168 },
    ],
  },
};

export const customHttpMeta: ConnectorMeta = {
  type: 'custom_http',
  label: 'Custom HTTP (LLM extract)',
  description:
    'Fetch any URL on a schedule, batch the response through an LLM with your extraction prompt, and assert entities + facts. The connector wizard generates the spec from a URL + a free-text description; no code required.',
  category: 'tool',
  emits_signal_source: 'custom_http',
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      { name: 'fetch', label: 'Fetch spec (JSON)', kind: 'textarea', required: true,
        help: 'Object with url, method, headers, body, response_path. Use ${env:NAME} for env vars.' },
      { name: 'extract', label: 'Extract spec (JSON)', kind: 'textarea', required: true,
        help: 'Object with system_prompt, batch_size, model. The prompt MUST tell the LLM the exact output JSON shape (see custom_http.ts docs).' },
      { name: 'signal', label: 'Signal spec (JSON, optional)', kind: 'textarea',
        help: 'Object with type, magnitude. Optional — defaults shown.' },
      { name: 'dedup', label: 'Dedup spec (JSON, optional)', kind: 'textarea',
        help: 'Object with since_hours, item_id_path. Without item_id_path the item itself is hashed for dedup.' },
    ],
  },
};

export const inboundWebhookMeta: ConnectorMeta = {
  type: 'inbound_webhook',
  label: 'Inbound webhook (push)',
  description:
    'A push endpoint anything can POST rows to — Clay, Zapier, n8n, a script. Maps incoming JSON to accounts + contacts + facts via a field-mapping spec. Idempotent. POST to /api/ingest/webhook?source=<id> with your workspace API key as a Bearer token.',
  category: 'tool',
  emits_signal_source: 'webhook',
  // Push-only: the dispatcher never pulls this. Set far in the future so the
  // cadence sweep never flags it as stale.
  schedule_cron: '0 0 1 1 *',
  config_schema: {
    fields: [
      {
        name: 'ingest_spec',
        label: 'Field mapping (JSON)',
        kind: 'textarea',
        required: true,
        help: 'Maps incoming row fields to account/contact/facts. Dot paths resolve against each row. Edit to match what your tool sends.',
        default: JSON.stringify(
          {
            account_name_path: 'company',
            account_domain_path: 'domain',
            contact_email_path: 'email',
            contact_name_path: 'name',
            contact_role_path: 'title',
            item_id_path: 'id',
            fact_map: [],
            signal: { magnitude: 0.5 },
          },
          null,
          2,
        ),
      },
    ],
  },
};

export const exaMeta: ConnectorMeta = {
  type: 'exa',
  label: 'Exa (semantic web search)',
  description: 'Search the open web with rendered page contents. Use for hiring discovery, news, anything JS-hydrated. Requires EXA_API_KEY.',
  category: 'tool',
  emits_signal_source: 'exa',
  cost: 'metered', // each search costs Exa credits
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      { name: 'query', label: 'Search query', kind: 'text', required: true,
        help: 'Free-form. Example: "Founding GTM hire YC startup" or "Series A fintech AI announcement".' },
      { name: 'intent', label: 'Intent', kind: 'text', default: 'discover',
        help: '"discover" creates entities per company found. "watch" only emits signals on items mentioning watch_entities.' },
      { name: 'watch_entities', label: 'Entities to watch (watch mode only)', kind: 'entity_picker_multi',
        help: 'Leave empty for discover mode.' },
      { name: 'include_domains', label: 'Restrict to domains (optional)', kind: 'string_array',
        help: 'Comma-separated root domains to limit search to. Leave empty for the open web.' },
      { name: 'exclude_domains', label: 'Exclude domains (optional)', kind: 'string_array' },
      { name: 'roles', label: 'Role keywords (free text)', kind: 'string_array',
        help: 'For hiring intents. Folded into result-extraction prompt.' },
      { name: 'keywords', label: 'Other keywords (free text)', kind: 'string_array' },
      { name: 'num_results', label: 'Max results per run', kind: 'number', default: 25 },
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 168 },
      { name: 'search_type', label: 'Search type', kind: 'text', default: 'auto',
        help: '"auto" (Exa picks), "keyword", or "neural" (semantic).' },
    ],
  },
};

export const exaContactsMeta: ConnectorMeta = {
  type: 'exa_contacts',
  label: 'Exa (contact signals)',
  description: 'Pulls a recent web signal for your CONTACTS (people), one targeted search each, so the contact scorer fires on a real detected event. Bounded to high-fit accounts. Requires EXA_API_KEY.',
  category: 'tool',
  emits_signal_source: 'exa_contacts',
  cost: 'metered', // one Exa search per contact
  schedule_cron: '0 14 * * *',
  config_schema: {
    fields: [
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 720,
        help: 'Recency window for each person search. 720 = 30 days.' },
      { name: 'max_contacts', label: 'Max contacts per run', kind: 'number', default: 10,
        help: 'Cost cap. One Exa search (~$0.005) per contact, best-fit first.' },
      { name: 'min_account_fit', label: 'Min account ICP fit', kind: 'number', default: 0.5,
        help: 'Only search contacts whose account scores at least this. 0-1.' },
      { name: 'num_results', label: 'Results per contact', kind: 'number', default: 3 },
      { name: 'cooldown_hours', label: 'Per-contact cooldown (hours)', kind: 'number', default: 336,
        help: 'Skip a contact that already got a signal within this window. 336 = 14 days.' },
    ],
  },
};

export const webMeta: ConnectorMeta = {
  type: 'web',
  label: 'Web / RSS scrape',
  description: 'Fetch any URL. Auto-detects RSS; falls back to HTML + LLM extraction. Watch mode filters to known entities; discover mode creates entities per company found. Best for static URLs and RSS feeds.',
  category: 'tool',
  emits_signal_source: 'web',
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      { name: 'url', label: 'URL to fetch', kind: 'text', required: true,
        help: 'Full URL of an RSS/Atom feed or HTML page to scrape.' },
      { name: 'intent', label: 'Intent', kind: 'text', default: 'auto',
        help: '"watch" (filter to known entities), "discover" (create entities per item), "auto" (watch if watch_entities populated, else discover).' },
      { name: 'watch_entities', label: 'Entities to watch (watch mode only)', kind: 'entity_picker_multi',
        help: 'Leave empty for discover mode. Required for watch mode.' },
      { name: 'roles', label: 'Role keywords (free text)', kind: 'string_array',
        help: 'Comma-separated. Folded into the extraction prompt as a filter. Example: "Founding GTM, GTM Engineer, Growth, Automation Engineer".' },
      { name: 'keywords', label: 'Other keywords (free text)', kind: 'string_array',
        help: 'Comma-separated. Same as roles but for non-role criteria. Example: "remote, equity > 1%, San Francisco".' },
      { name: 'fetch_mode', label: 'Fetch mode', kind: 'text', default: 'auto',
        help: '"auto" (detect RSS vs HTML), "rss" (force feed parsing), "html" (force LLM extraction).' },
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 168,
        help: 'Skip items older than this. Default 168 = 1 week.' },
      { name: 'extraction_prompt', label: 'Extraction hint (HTML mode only)', kind: 'textarea',
        help: 'Optional. e.g. "Find job listings. Each has a role, company, location, posted date."' },
    ],
  },
};

export const hnMeta: ConnectorMeta = {
  type: 'hn',
  label: 'Hacker News',
  description: 'Watch HN for posts mentioning specific companies. Uses the free Algolia search API.',
  category: 'preset',
  emits_signal_source: 'hn',
  schedule_cron: '0 * * * *',
  config_schema: {
    fields: [
      { name: 'watch_entities', label: 'Companies to watch (optional override)', kind: 'entity_picker_multi',
        help: 'Leave empty to watch every account in the workspace. Set explicitly to scope down.' },
      { name: 'keywords', label: 'Additional keywords (optional)', kind: 'string_array',
        help: 'Comma-separated. Narrows the HN search before entity matching. Leave empty for no narrowing.' },
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 24,
        help: 'Fetch posts created in the last N hours.' },
      { name: 'min_points', label: 'Minimum HN points', kind: 'number', default: 0,
        help: 'Skip posts below this score. Set higher to reduce noise.' },
    ],
  },
};

export const ycMeta: ConnectorMeta = {
  type: 'yc',
  label: 'Y Combinator (companies)',
  description: 'Pull active YC companies from the directory. Creates account entities (deduped by domain) and emits signals so agents can score / enrich them.',
  category: 'preset',
  emits_signal_source: 'yc',
  schedule_cron: '0 6 1 */3 *',
  config_schema: {
    fields: [
      { name: 'batches', label: 'Batches (optional)', kind: 'string_array',
        help: 'Comma-separated, e.g. "W25, S25". Leave empty to ingest all active companies.' },
      { name: 'statuses', label: 'Statuses to include', kind: 'string_array', default: ['Active'],
        help: 'Default: Active. Other options: Acquired, Public, Inactive.' },
      { name: 'industries', label: 'Industries (optional substring match)', kind: 'string_array',
        help: 'e.g. "B2B, Fintech". Empty = all industries.' },
      { name: 'max_per_run', label: 'Max companies per run', kind: 'number', default: 200,
        help: 'Safety cap. First run on a fresh workspace can be slow; raise to 1000+ once entities exist.' },
    ],
  },
};

const HIGH_SIGNAL_TYPES = ['ReleaseEvent', 'PublicEvent', 'CreateEvent', 'MemberEvent', 'ForkEvent'];

export const githubMeta: ConnectorMeta = {
  type: 'github',
  label: 'GitHub Events',
  description: 'Watch GitHub orgs for releases, new repos, new members. Auth via GITHUB_TOKEN env (5000 req/hr) or unauth (60 req/hr).',
  category: 'preset',
  emits_signal_source: 'github',
  schedule_cron: '*/30 * * * *',
  config_schema: {
    fields: [
      { name: 'watch_entities', label: 'Companies to watch', kind: 'entity_picker_multi', required: true,
        help: 'Add an alias starting with "github:<org>" (e.g. "github:stripe") for each entity. If absent, uses lowercased entity name.' },
      { name: 'event_types', label: 'Event types', kind: 'string_array', default: HIGH_SIGNAL_TYPES,
        help: 'Defaults to release / new repo / new contributor / fork. Add WatchEvent, IssuesEvent, etc. for more noise.' },
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 24 },
    ],
  },
};

export const githubTrendingMeta: ConnectorMeta = {
  type: 'github_trending',
  label: 'GitHub Trending',
  description: 'Search public repos by topic + language + recency. Emit a signal when a result mentions a workspace entity in its name, description, or owner. No per-org subscription needed.',
  category: 'preset',
  emits_signal_source: 'github_trending',
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      { name: 'topics', label: 'GitHub topics (OR)', kind: 'string_array',
        help: 'e.g. ai-agents, llm, retrieval-augmented-generation. At least one of topics/language should be set.' },
      { name: 'language', label: 'Language filter', kind: 'text',
        help: 'e.g. python, typescript. Optional.' },
      { name: 'pushed_since', label: 'Pushed since (YYYY-MM-DD)', kind: 'text',
        help: 'Only consider repos pushed since this date. Default: 30 days ago.' },
      { name: 'min_stars', label: 'Minimum stars', kind: 'number', default: 25 },
      { name: 'max_results', label: 'Max results per run', kind: 'number', default: 100 },
      { name: 'watch_entities', label: 'Companies to watch (optional override)', kind: 'entity_picker_multi',
        help: 'Leave empty to match against every account in the workspace.' },
    ],
  },
};

export const producthuntMeta: ConnectorMeta = {
  type: 'producthunt',
  label: 'Product Hunt',
  description: 'Today\'s launches from Product Hunt. Requires PRODUCTHUNT_TOKEN env. Free developer access.',
  category: 'preset',
  emits_signal_source: 'producthunt',
  schedule_cron: '0 14 * * *',
  config_schema: {
    fields: [
      { name: 'watch_entities', label: 'Companies to watch', kind: 'entity_picker_multi', required: true,
        help: 'Match by name / website / maker username. Use aliases for known maker handles.' },
      { name: 'since_hours', label: 'Look back (hours)', kind: 'number', default: 24 },
      { name: 'min_votes', label: 'Minimum votes', kind: 'number', default: 0 },
    ],
  },
};

export const atsMeta: ConnectorMeta = {
  type: 'ats',
  label: 'ATS hiring (Greenhouse / Lever / Ashby / Workable)',
  description:
    'Watch public ATS job boards (Greenhouse, Lever, Ashby, Workable) for every active workspace account. New role posting = hiring_post signal. Free, no API keys. Discovery is lazy: probes each provider per entity on first encounter and caches the result on entity.attributes.',
  category: 'preset',
  emits_signal_source: 'ats',
  schedule_cron: '0 13 * * *', // daily at 13:00 UTC — jobs change on human timescales
  config_schema: {
    fields: [
      { name: 'providers', label: 'Providers (optional)', kind: 'string_array', default: ['greenhouse', 'lever', 'ashby', 'workable'],
        help: 'Default: all four. Narrow if you only want hits from specific providers.' },
      { name: 'reprobe_days', label: 'Re-probe negative results after (days)', kind: 'number', default: 30,
        help: 'Companies marked as "no ATS detected" get re-probed after this many days in case they\'ve adopted one.' },
      { name: 'max_entities_per_run', label: 'Max entities per run', kind: 'number', default: 200,
        help: 'Safety cap. First run on a large watchlist will be slow; raise to cover everything sooner.' },
      { name: 'max_new_signals_per_entity', label: 'Max new signals per company per run', kind: 'number',
        help: 'Optional ceiling so one big employer can\'t flood a run. Keeps the freshest N new roles per company; the rest are skipped. Leave blank for no cap.' },
    ],
  },
};

export const CONNECTOR_METAS: Record<string, ConnectorMeta> = {
  api_call: apiCallMeta,
  custom_http: customHttpMeta,
  inbound_webhook: inboundWebhookMeta,
  exa: exaMeta,
  exa_contacts: exaContactsMeta,
  web: webMeta,
  hn: hnMeta,
  yc: ycMeta,
  github: githubMeta,
  github_trending: githubTrendingMeta,
  producthunt: producthuntMeta,
  ats: atsMeta,
};

export function listConnectors(): ConnectorMeta[] {
  return Object.values(CONNECTOR_METAS);
}
