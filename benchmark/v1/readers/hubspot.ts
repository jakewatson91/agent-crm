/**
 * HubSpot side reader for v1 benchmark.
 *
 * Three real tool implementations (no stubs):
 *   - hubspot_get_company_by_name        → POST /crm/v3/objects/companies/search
 *   - hubspot_get_associated_contacts    → GET associations + batch read contacts
 *   - hubspot_get_recent_notes           → POST /crm/v3/objects/notes/search by association
 *
 * Each call returns { request, response } so receipts can show exactly what
 * went over the wire. The drafter task is unchanged from v0; only the data
 * source is now real instead of hand-constructed.
 */

import type { Tool } from '../lib/llm.js';

const HS_BASE = 'https://api.hubapi.com';

export interface HubSpotApiCall {
  tool: string;
  request: { method: string; url: string; body?: unknown };
  response: { status: number; body: unknown };
  latency_ms: number;
}

function getKey(): string {
  const k = process.env.HUBSPOT_SERVICE_KEY;
  if (!k) throw new Error('Missing HUBSPOT_SERVICE_KEY');
  return k;
}

async function hsCall(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${HS_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// Read shapes:
//   'current'  — the v1.0 default. ~10 company props, ~7 contact props, ~4 note props.
//   'naive'    — omit `properties` entirely. HubSpot returns its full default set
//                (20+ company props, 8+ contact props, all note props). What a lazy
//                agent dev would write.
//   'tight'    — minimum fields the drafter actually needs (4 company, 4 contact,
//                2 note). What a smart agent dev would write after reading our prompt.
export type HubSpotShape = 'current' | 'naive' | 'tight';

const COMPANY_PROPS: Record<HubSpotShape, string[] | undefined> = {
  current: ['name', 'domain', 'industry', 'description', 'lifecyclestage', 'numberofemployees', 'founded_year', 'type', 'createdate', 'hs_lastmodifieddate'],
  naive: undefined,
  tight: ['name', 'domain', 'industry', 'description'],
};
const CONTACT_PROPS: Record<HubSpotShape, string[] | undefined> = {
  current: ['email', 'firstname', 'lastname', 'jobtitle', 'phone', 'createdate', 'lastmodifieddate'],
  naive: undefined,
  tight: ['email', 'firstname', 'lastname', 'jobtitle'],
};
const NOTE_PROPS: Record<HubSpotShape, string[] | undefined> = {
  current: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  naive: undefined,
  tight: ['hs_note_body', 'hs_timestamp'],
};

export async function getCompanyByName(name: string, shape: HubSpotShape = 'current'): Promise<HubSpotApiCall> {
  const body: Record<string, unknown> = {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
    limit: 1,
  };
  if (COMPANY_PROPS[shape]) body.properties = COMPANY_PROPS[shape];
  const t0 = Date.now();
  const resp = await hsCall('POST', '/crm/v3/objects/companies/search', body);
  return {
    tool: 'hubspot_get_company_by_name',
    request: { method: 'POST', url: `${HS_BASE}/crm/v3/objects/companies/search`, body },
    response: resp,
    latency_ms: Date.now() - t0,
  };
}

export async function getAssociatedContacts(companyId: string, shape: HubSpotShape = 'current'): Promise<HubSpotApiCall> {
  const t0 = Date.now();
  const assoc = await hsCall('GET', `/crm/v3/objects/companies/${companyId}/associations/contacts`);
  const ids = (((assoc.body as { results?: Array<{ id?: string; toObjectId?: string | number }> }).results ?? [])
    .map((r) => String(r.toObjectId ?? r.id ?? ''))
    .filter(Boolean));
  let batchBody: Record<string, unknown> | null = null;
  let batchResp: { status: number; body: unknown } = { status: 200, body: { results: [] } };
  if (ids.length) {
    batchBody = { inputs: ids.map((id) => ({ id })) };
    if (CONTACT_PROPS[shape]) batchBody.properties = CONTACT_PROPS[shape];
    batchResp = await hsCall('POST', '/crm/v3/objects/contacts/batch/read', batchBody);
  }
  return {
    tool: 'hubspot_get_associated_contacts',
    request: {
      method: 'POST',
      url: `${HS_BASE}/crm/v3/objects/contacts/batch/read (after GET /companies/${companyId}/associations/contacts)`,
      body: { association_response: assoc.body, batch_read_body: batchBody },
    },
    response: batchResp,
    latency_ms: Date.now() - t0,
  };
}

export async function getRecentNotes(companyId: string, shape: HubSpotShape = 'current', limit = 5): Promise<HubSpotApiCall> {
  const body: Record<string, unknown> = {
    filterGroups: [{ filters: [{ propertyName: 'associations.company', operator: 'EQ', value: companyId }] }],
    sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
    limit,
  };
  if (NOTE_PROPS[shape]) body.properties = NOTE_PROPS[shape];
  const t0 = Date.now();
  const resp = await hsCall('POST', '/crm/v3/objects/notes/search', body);
  return {
    tool: 'hubspot_get_recent_notes',
    request: { method: 'POST', url: `${HS_BASE}/crm/v3/objects/notes/search`, body },
    response: resp,
    latency_ms: Date.now() - t0,
  };
}

export const HUBSPOT_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'hubspot_get_company_by_name',
      description: 'Fetch a HubSpot company by exact name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hubspot_get_associated_contacts',
      description: 'Fetch contacts associated with a HubSpot company id.',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hubspot_get_recent_notes',
      description: 'Fetch the 5 most recent notes (engagements) on a HubSpot company id.',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
    },
  },
];

export async function execTool(name: string, args: Record<string, unknown>, shape: HubSpotShape = 'current'): Promise<HubSpotApiCall> {
  switch (name) {
    case 'hubspot_get_company_by_name': return getCompanyByName(args.name as string, shape);
    case 'hubspot_get_associated_contacts': return getAssociatedContacts(args.company_id as string, shape);
    case 'hubspot_get_recent_notes': return getRecentNotes(args.company_id as string, shape);
    default: throw new Error(`unknown tool: ${name}`);
  }
}
