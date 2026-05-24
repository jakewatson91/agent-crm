/**
 * Curated catalogs of Composio actions per toolkit.
 *
 * Composio exposes hundreds of actions per toolkit (Gmail alone has ~80).
 * The agent doesn't need most of them, and exposing the full list pollutes
 * the model's tool-selection prompt and increases the chance of bad calls.
 *
 * Each catalog entry: { slug, scope, summary }. The agent only sees actions
 * listed here. `summary` overrides Composio's verbose default description
 * with one line the model can scan quickly.
 *
 * Add toolkits/actions as we wire them up. Empty catalog == toolkit is
 * available for OAuth handoff but the agent can't call any actions yet.
 */
import type { ToolScope } from './scope.ts';

export interface CuratedAction {
  slug: string;
  scope: ToolScope;
  summary: string;
}

export interface ToolkitCatalog {
  slug: string;
  label: string;
  description: string;
  actions: CuratedAction[];
}

// v1: read-only. Outbound (send / post / create) from the user's own
// connected accounts is deferred to a later pass — see MEMORY.md entry
// `project_composio_v1_read_only`.
const GMAIL: ToolkitCatalog = {
  slug: 'gmail',
  label: 'Gmail',
  description: 'Read email from a connected Gmail account.',
  actions: [
    { slug: 'GMAIL_FETCH_EMAILS', scope: 'read', summary: 'Fetch recent emails matching a query.' },
    { slug: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', scope: 'read', summary: 'Fetch all messages in a thread.' },
    { slug: 'GMAIL_LIST_THREADS', scope: 'read', summary: 'List threads matching a query.' },
    { slug: 'GMAIL_GET_PROFILE', scope: 'read', summary: 'Get the connected user profile.' },
  ],
};

const SLACK: ToolkitCatalog = {
  slug: 'slack',
  label: 'Slack',
  description: 'Read channels and users in a connected Slack workspace.',
  actions: [
    { slug: 'SLACK_LIST_ALL_SLACK_TEAM_CHANNELS_WITH_VARIOUS_FILTERS', scope: 'read', summary: 'List channels in the workspace.' },
    { slug: 'SLACK_LIST_ALL_USERS', scope: 'read', summary: 'List workspace users.' },
    { slug: 'SLACK_FETCH_CONVERSATION_HISTORY', scope: 'read', summary: 'Read recent messages from a channel.' },
  ],
};

const GOOGLECALENDAR: ToolkitCatalog = {
  slug: 'googlecalendar',
  label: 'Google Calendar',
  description: 'Read events from a connected Google Calendar.',
  actions: [
    { slug: 'GOOGLECALENDAR_LIST_EVENTS', scope: 'read', summary: 'List upcoming or past events.' },
    { slug: 'GOOGLECALENDAR_FIND_EVENT', scope: 'read', summary: 'Find an event by query.' },
  ],
};

const HUBSPOT: ToolkitCatalog = {
  slug: 'hubspot',
  label: 'HubSpot',
  description: 'Read contacts, companies, deals from a connected HubSpot account.',
  actions: [
    { slug: 'HUBSPOT_LIST_CONTACTS', scope: 'read', summary: 'List contacts.' },
    { slug: 'HUBSPOT_LIST_COMPANIES', scope: 'read', summary: 'List companies.' },
    { slug: 'HUBSPOT_LIST_DEALS', scope: 'read', summary: 'List deals.' },
    { slug: 'HUBSPOT_GET_CONTACT', scope: 'read', summary: 'Fetch a single contact by id.' },
    { slug: 'HUBSPOT_GET_COMPANY', scope: 'read', summary: 'Fetch a single company by id.' },
  ],
};

const SALESFORCE: ToolkitCatalog = {
  slug: 'salesforce',
  label: 'Salesforce',
  description: 'Read accounts, contacts, opportunities from a connected Salesforce org.',
  actions: [
    { slug: 'SALESFORCE_GET_ACCOUNT', scope: 'read', summary: 'Fetch an account by id.' },
    { slug: 'SALESFORCE_GET_CONTACT', scope: 'read', summary: 'Fetch a contact by id.' },
    { slug: 'SALESFORCE_SOQL_QUERY', scope: 'read', summary: 'Run a SOQL query (read-only).' },
  ],
};

export const TOOLKITS: Record<string, ToolkitCatalog> = {
  gmail: GMAIL,
  slack: SLACK,
  googlecalendar: GOOGLECALENDAR,
  hubspot: HUBSPOT,
  salesforce: SALESFORCE,
};

export function listToolkits(): ToolkitCatalog[] {
  return Object.values(TOOLKITS);
}

export function getToolkit(slug: string): ToolkitCatalog | undefined {
  return TOOLKITS[slug.toLowerCase()];
}

export function findAction(slug: string): { toolkit: ToolkitCatalog; action: CuratedAction } | undefined {
  const up = slug.toUpperCase();
  for (const tk of Object.values(TOOLKITS)) {
    const a = tk.actions.find((x) => x.slug === up);
    if (a) return { toolkit: tk, action: a };
  }
  return undefined;
}
