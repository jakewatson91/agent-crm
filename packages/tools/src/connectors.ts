/**
 * Connector registry — the list of outside services agent-crm knows how to use,
 * plus a pure function that turns a workspace's saved config into a per-connector
 * status the settings page renders.
 *
 * This is the integration registry, the same idea as the Composio toolkit
 * catalog (packages/composio/src/catalog.ts): the *identities* of the services
 * we ship code for live here in code; the *values* (the API keys, which provider
 * is primary) live in workspaces.policy and default to empty. Nothing here is
 * specific to any customer or industry — a fork gets the same list and fills in
 * its own keys.
 *
 * Three kinds of connector:
 *   - model    : an LLM / embedding provider. Keyed by an env var; the agent
 *                sends completions to whichever model id the workspace points at.
 *   - contact  : a people/company lookup service (email + role). The agent tries
 *                the primary, then the fallback, so a workspace can run one and
 *                add a backup without touching code.
 *   - research : a web-search / page-fetch provider for deep account research.
 *   - email    : the outbound-send provider.
 *   - app      : an OAuth app (Gmail, Slack, HubSpot, ...) connected through
 *                Composio. Those are listed dynamically from the Composio catalog,
 *                not here — this registry covers the key-based services.
 */
import type { WorkspacePolicy, PipelineStatus } from './policy.ts';

export type ConnectorCategory = 'model' | 'contact' | 'research' | 'email';

/** One input the user fills in when connecting a service. */
export interface ConnectorField {
  /** The name stored under policy.env (default) unless policy_path is set. */
  key: string;
  label: string;
  placeholder: string;
  help?: string;
  /** 'secret' masks the value and never sends it back to the browser. */
  type?: 'secret' | 'text' | 'number';
  optional?: boolean;
  /**
   * When set, the value is written into workspaces.policy at this dot path
   * (e.g. 'outreach.from_email') instead of policy.env. Lets a card carry a
   * non-secret setting that belongs elsewhere in policy.
   */
  policy_path?: string;
}

export interface ConnectorDef {
  id: string;
  name: string;
  category: ConnectorCategory;
  /** One plain-English line: what this service does for the workspace. */
  blurb: string;
  /** What the agent can do once it's connected. Plain English, one item per line. */
  capabilities: string[];
  /** Where to get a key. Shown as a link in the connect dialog. */
  get_key_url?: string;
  /** Theme accent for the card icon. One of the --accent-* families. */
  accent: 'blue' | 'green' | 'amber' | 'coral' | 'purple';
  fields: ConnectorField[];
  /**
   * For contact connectors: the value written to
   * policy.enrichment.contact_provider when this is chosen as the source.
   */
  provider_id?: string;
  /** True when /api/connectors/verify can run a live check for this service. */
  verifiable?: boolean;
  /**
   * For model providers: show the "which model id" hints. The agent accepts any
   * model id the registry understands, so this is guidance, not a fixed list.
   */
  model_hint?: string[];
  /**
   * Ties this connector to a pipeline pause. policy.pipeline.provider is one of
   * deepseek / hunter / explorium / llm; a match surfaces the pause as an alert
   * on this card. 'llm' matches any model connector.
   */
  pipeline_providers?: string[];
}

// ---- Model / embedding providers ------------------------------------------

const DEEPSEEK: ConnectorDef = {
  id: 'deepseek',
  name: 'DeepSeek',
  category: 'model',
  blurb: 'The default model for scoring, research, drafting, and chat. Cheapest option for high volume.',
  capabilities: [
    'Scores every account and contact against your ICP.',
    'Writes the outbound drafts you approve.',
    'Answers your questions in chat.',
  ],
  get_key_url: 'https://platform.deepseek.com/api_keys',
  accent: 'blue',
  verifiable: true,
  pipeline_providers: ['deepseek', 'llm'],
  model_hint: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'],
  fields: [
    { key: 'DEEPSEEK_API_KEY', label: 'API key', placeholder: 'sk-...', type: 'secret' },
  ],
};

const AI_GATEWAY: ConnectorDef = {
  id: 'ai_gateway',
  name: 'AI Gateway',
  category: 'model',
  blurb: 'One key to run Claude, GPT, Gemini, and more. Point any model setting at "vendor/model" and it just works.',
  capabilities: [
    'Lets you pick a non-DeepSeek model for drafting or chat.',
    'Handles Anthropic, OpenAI, Google, xAI and others through a single key.',
  ],
  get_key_url: 'https://vercel.com/docs/ai-gateway',
  accent: 'purple',
  verifiable: false,
  pipeline_providers: ['llm'],
  model_hint: ['anthropic/claude-opus-4-8', 'openai/gpt-5', 'google/gemini-2.5-pro'],
  fields: [
    { key: 'AI_GATEWAY_API_KEY', label: 'API key', placeholder: 'vck_...', type: 'secret' },
  ],
};

const OPENAI_EMBED: ConnectorDef = {
  id: 'openai',
  name: 'OpenAI (embeddings)',
  category: 'model',
  blurb: 'Powers the similarity search behind scoring and entity matching. Needed for the agent to rank accounts.',
  capabilities: [
    'Turns every fact into a vector so accounts can be matched to your ICP.',
    'Also usable for GPT models if you route them directly.',
  ],
  get_key_url: 'https://platform.openai.com/api-keys',
  accent: 'green',
  verifiable: true,
  pipeline_providers: ['llm'],
  fields: [
    { key: 'OPENAI_API_KEY', label: 'API key', placeholder: 'sk-...', type: 'secret' },
  ],
};

// ---- Contact sources ------------------------------------------------------

const HUNTER: ConnectorDef = {
  id: 'hunter',
  name: 'Hunter.io',
  category: 'contact',
  blurb: 'Finds work email addresses by company domain. Broad coverage; weaker on brand-new startups.',
  capabilities: [
    'Pulls decision-maker names and emails for an account.',
    'Free tier: 25 lookups a month.',
  ],
  get_key_url: 'https://hunter.io/api-keys',
  accent: 'amber',
  provider_id: 'hunter',
  verifiable: true,
  pipeline_providers: ['hunter'],
  fields: [
    { key: 'HUNTER_API_KEY', label: 'API key', placeholder: 'Hunter API key', type: 'secret' },
    { key: 'hunter_monthly_cap', label: 'Monthly lookup cap', placeholder: '0 = no cap', type: 'number', optional: true, policy_path: 'enrichment.hunter_monthly_cap' },
  ],
};

const EXPLORIUM: ConnectorDef = {
  id: 'explorium',
  name: 'Explorium',
  category: 'contact',
  blurb: 'Finds decision-makers and emails, with better coverage on small and early-stage companies.',
  capabilities: [
    'Matches a company by domain, then pulls senior contacts and their emails.',
    'Ranks founders and executives first, so credits go to the right people.',
  ],
  get_key_url: 'https://developers.explorium.ai',
  accent: 'coral',
  provider_id: 'explorium',
  verifiable: true,
  pipeline_providers: ['explorium'],
  fields: [
    { key: 'EXPLORIUM_API_KEY', label: 'API key', placeholder: 'Explorium API key', type: 'secret' },
  ],
};

// ---- Web research ---------------------------------------------------------

const EXA: ConnectorDef = {
  id: 'exa',
  name: 'Exa',
  category: 'research',
  blurb: 'Web search and page reading for deep account research. Feeds the agent facts to write with.',
  capabilities: [
    'Runs the AI-planned searches for each prospect.',
    'Reads company blogs, launches, and news into facts.',
  ],
  get_key_url: 'https://dashboard.exa.ai/api-keys',
  accent: 'blue',
  verifiable: true,
  fields: [
    { key: 'EXA_API_KEY', label: 'API key', placeholder: 'Exa API key', type: 'secret' },
    { key: 'EXA_SERVICE_API_KEY', label: 'Service key (optional, for real cost)', placeholder: 'Team Management service key', type: 'secret', optional: true },
  ],
};

// ---- Email ----------------------------------------------------------------

const RESEND: ConnectorDef = {
  id: 'resend',
  name: 'Resend',
  category: 'email',
  blurb: 'Sends the outbound emails you approve. Works out of the box with a shared sender; add a domain to send as yourself.',
  capabilities: [
    'Delivers approved drafts to real recipients.',
    'Uses your verified domain when you set one.',
  ],
  get_key_url: 'https://resend.com/api-keys',
  accent: 'green',
  verifiable: true,
  fields: [
    { key: 'RESEND_API_KEY', label: 'API key', placeholder: 're_...', type: 'secret' },
    { key: 'from_email', label: 'From address', placeholder: 'onboarding@resend.dev', type: 'text', optional: true, policy_path: 'outreach.from_email' },
  ],
};

export const CONNECTORS: ConnectorDef[] = [
  DEEPSEEK, AI_GATEWAY, OPENAI_EMBED,
  HUNTER, EXPLORIUM,
  EXA,
  RESEND,
];

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export const CONNECTOR_CATEGORIES: Array<{ id: ConnectorCategory; label: string; hint: string }> = [
  { id: 'model',    label: 'Models',         hint: 'The brains. Score, research, draft, chat.' },
  { id: 'contact',  label: 'Contact sources', hint: 'Find the people to email. Agent tries primary, then fallback.' },
  { id: 'research', label: 'Web research',   hint: 'Search and read the web for facts to write with.' },
  { id: 'email',    label: 'Email',          hint: 'Send the outbound you approve.' },
];

// ---- Status resolution (pure) ---------------------------------------------

export type ConnectorHealth = 'connected' | 'not_connected' | 'error';

/** One connector's state, computed from saved config. No secret values here. */
export interface ConnectorState {
  id: string;
  /** Every required field has a value saved. */
  configured: boolean;
  /** Which required env keys are still missing (names only). */
  missing_keys: string[];
  /** Required keys satisfied only by the server environment, not this workspace. */
  from_server: string[];
  health: ConnectorHealth;
  /** For contact connectors: 'primary' | 'fallback' | null. */
  role: 'primary' | 'fallback' | null;
  /** A credit/auth problem the pipeline reported for this service. */
  alert: { message: string } | null;
}

export interface ResolveStateInput {
  /** Env-var names saved on THIS workspace (policy.env). Booleans only. */
  envPresent: Set<string>;
  /**
   * Env-var names set in the server environment (process.env). The agent falls
   * back to these when a workspace hasn't pasted its own, so a key here still
   * counts as connected — it just isn't editable per workspace on this page.
   */
  serverEnvPresent?: Set<string>;
  /** Non-secret policy values that back policy_path fields, by dot path. */
  policyValues: Record<string, unknown>;
  contactPrimary?: string;   // policy.enrichment.contact_provider
  contactFallback?: string;  // policy.enrichment.contact_provider_fallback
  pipeline?: PipelineStatus | null;
}

/** Where a field's value comes from, if anywhere. */
function fieldSource(f: ConnectorField, input: ResolveStateInput): 'workspace' | 'server' | 'none' {
  if (f.policy_path) {
    const v = input.policyValues[f.policy_path];
    return v !== undefined && v !== null && v !== '' ? 'workspace' : 'none';
  }
  if (input.envPresent.has(f.key)) return 'workspace';
  if (input.serverEnvPresent?.has(f.key)) return 'server';
  return 'none';
}

export function resolveConnectorState(def: ConnectorDef, input: ResolveStateInput): ConnectorState {
  const requiredFields = def.fields.filter((f) => !f.optional);
  const missing_keys = requiredFields.filter((f) => fieldSource(f, input) === 'none').map((f) => f.key);
  const configured = missing_keys.length === 0;
  // Keys the agent has only because the server environment provides them.
  const from_server = requiredFields.filter((f) => fieldSource(f, input) === 'server').map((f) => f.key);

  let role: ConnectorState['role'] = null;
  if (def.provider_id) {
    if (input.contactPrimary === def.provider_id) role = 'primary';
    else if (input.contactFallback === def.provider_id) role = 'fallback';
  }

  // Surface a pipeline pause that names this service as a per-card alert.
  let alert: ConnectorState['alert'] = null;
  const pl = input.pipeline;
  if (pl?.state === 'paused' && pl.provider && def.pipeline_providers?.includes(pl.provider)) {
    alert = { message: pl.reason ?? 'This service paused the pipeline.' };
  }

  const health: ConnectorHealth = alert ? 'error' : configured ? 'connected' : 'not_connected';
  return { id: def.id, configured, missing_keys, from_server, health, role, alert };
}
