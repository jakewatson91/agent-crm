/**
 * Attio side reader for v1 benchmark.
 *
 * Tool surface (mirrors what an Attio agent dev would build with their REST API):
 *   - attio_search_company_by_name        — find a company record by name
 *   - attio_get_company_people            — find people linked to a company
 *   - attio_get_company_notes             — fetch notes attached to a company
 *
 * Two shapes:
 *   - default: full records (Attio's verbose value-wrapper format)
 *   - tight:   custom select via `attributes` filter (minimum useful fields)
 */

import type { Tool } from '../lib/llm.js';

const BASE = 'https://api.attio.com';

export type AttioShape = 'default' | 'tight';

export interface AttioApiCall {
  tool: string;
  request: { method: string; url: string; body?: unknown };
  response: { status: number; body: unknown };
  latency_ms: number;
}

function getKey(): string {
  const k = process.env.ATTIO_API_KEY;
  if (!k) throw new Error('Missing ATTIO_API_KEY');
  return k;
}

async function attioCall(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const TIGHT_COMPANY_ATTRS = ['name', 'domains', 'description'];
const TIGHT_PEOPLE_ATTRS = ['name', 'email_addresses', 'job_title'];

export async function searchCompanyByName(name: string, shape: AttioShape): Promise<AttioApiCall> {
  const body: Record<string, unknown> = {
    filter: { name: { $contains: name } },
    limit: 5,
  };
  if (shape === 'tight') body.attributes = TIGHT_COMPANY_ATTRS;
  const t0 = Date.now();
  const resp = await attioCall('POST', '/v2/objects/companies/records/query', body);
  return {
    tool: 'attio_search_company_by_name',
    request: { method: 'POST', url: `${BASE}/v2/objects/companies/records/query`, body },
    response: resp,
    latency_ms: Date.now() - t0,
  };
}

export async function getCompanyPeople(companyRecordId: string, shape: AttioShape): Promise<AttioApiCall> {
  const body: Record<string, unknown> = {
    filter: { company: { target_record_id: { $eq: companyRecordId } } },
    limit: 25,
  };
  if (shape === 'tight') body.attributes = TIGHT_PEOPLE_ATTRS;
  const t0 = Date.now();
  const resp = await attioCall('POST', '/v2/objects/people/records/query', body);
  return {
    tool: 'attio_get_company_people',
    request: { method: 'POST', url: `${BASE}/v2/objects/people/records/query`, body },
    response: resp,
    latency_ms: Date.now() - t0,
  };
}

export async function getCompanyNotes(companyRecordId: string, _shape: AttioShape): Promise<AttioApiCall> {
  const t0 = Date.now();
  // Attio notes GET endpoint doesn't have an attributes selector; the response shape is fixed.
  // tight vs default makes no difference here.
  const resp = await attioCall('GET', `/v2/notes?parent_object=companies&parent_record_id=${companyRecordId}&limit=10`);
  return {
    tool: 'attio_get_company_notes',
    request: { method: 'GET', url: `${BASE}/v2/notes?parent_object=companies&parent_record_id=${companyRecordId}&limit=10` },
    response: resp,
    latency_ms: Date.now() - t0,
  };
}

export const ATTIO_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'attio_search_company_by_name',
      description: 'Find an Attio Company record by name. Returns the company with all its attribute values.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attio_get_company_people',
      description: 'Fetch People records linked to an Attio company by company.target_record_id.',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attio_get_company_notes',
      description: 'Fetch Notes attached to an Attio company (notes are first-class objects with parent_object/parent_record_id).',
      parameters: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] },
    },
  },
];

export async function execAttioTool(name: string, args: Record<string, unknown>, shape: AttioShape = 'default'): Promise<AttioApiCall> {
  switch (name) {
    case 'attio_search_company_by_name': return searchCompanyByName(args.name as string, shape);
    case 'attio_get_company_people': return getCompanyPeople(args.company_id as string, shape);
    case 'attio_get_company_notes': return getCompanyNotes(args.company_id as string, shape);
    default: throw new Error(`unknown Attio tool: ${name}`);
  }
}
