/**
 * Day.ai side reader (simulated). Exposes a tool surface that mimics what
 * an agent built on the Day.ai SDK would call. Under the hood, calls the
 * simulator which produces Day.ai-shape responses from agent-crm data.
 *
 * Tool surface mirrors the SDK's search/get pattern:
 *   - dayai_search_organization(name)        — find org by name
 *   - dayai_get_contact(email)               — get full person record
 *   - dayai_search_notes(organization_domain) — get recent notes/context
 *
 * Shape control matches the SDK: shape = 'default' (everything) or 'tight'
 * (minimum fields). No middle ground because Day.ai's API has no equivalent
 * to HubSpot's "current" 10-prop list; you either pass propertiesToReturn or
 * not.
 */

import type { Tool } from '../lib/llm.js';
import { readProjection, type Projection } from './agent_crm.js';
import { buildOrganization, buildContact, buildNotes, type Shape, type SearchResultObject } from '../lib/dayai/simulator.js';

export type DayAiShape = Shape;

export interface DayAiApiCall {
  tool: string;
  request: { method: string; endpoint: string; body?: unknown };
  response: { status: number; body: unknown };
  latency_ms: number;
}

// Cache projections so we don't re-read Supabase across tool calls in a single run.
const projectionCache = new Map<string, Projection>();

async function getProjection(account: string): Promise<Projection> {
  if (projectionCache.has(account)) return projectionCache.get(account)!;
  const r = await readProjection(account);
  projectionCache.set(account, r.projection);
  return r.projection;
}

export function clearProjectionCache() { projectionCache.clear(); }

export async function searchOrganization(name: string, shape: DayAiShape): Promise<DayAiApiCall> {
  const t0 = Date.now();
  const projection = await getProjection(name);
  const org = buildOrganization(projection, shape);
  return {
    tool: 'dayai_search_organization',
    request: { method: 'POST', endpoint: '/v1/search', body: { query: { objectType: 'native_organization', where: { propertyId: 'name', operator: 'eq', value: name } }, options: shape === 'tight' ? { propertiesToReturn: ['name', 'domain', 'description', 'industry', 'funding', 'employeeCount', 'news', 'status/currentStatusOneSentence'], includeRelationships: false } : { propertiesToReturn: '*', includeRelationships: true } } },
    response: { status: 200, body: { native_organization: { totalCount: 1, results: [org] } } },
    latency_ms: Date.now() - t0,
  };
}

export async function getContact(email: string, account: string, shape: DayAiShape): Promise<DayAiApiCall> {
  const t0 = Date.now();
  const projection = await getProjection(account);
  const contact = buildContact(email, projection, shape);
  return {
    tool: 'dayai_get_contact',
    request: { method: 'POST', endpoint: '/v1/get', body: { query: { objectType: 'native_contact', objectIds: [email] }, options: shape === 'tight' ? { propertiesToReturn: ['email', 'firstName', 'lastName', 'currentJobTitle', 'currentCompanyName', 'description'], includeRelationships: false } : { propertiesToReturn: '*', includeRelationships: true } } },
    response: { status: contact ? 200 : 404, body: contact ? { native_contact: { totalCount: 1, results: [contact] } } : { native_contact: { totalCount: 0, results: [] } } },
    latency_ms: Date.now() - t0,
  };
}

export async function searchNotes(organizationDomain: string, account: string, shape: DayAiShape): Promise<DayAiApiCall> {
  const t0 = Date.now();
  const projection = await getProjection(account);
  const notes = buildNotes(projection, shape);
  return {
    tool: 'dayai_search_notes',
    request: { method: 'POST', endpoint: '/v1/search', body: { query: { objectType: 'native_context', where: { relationship: 'parent', targetObjectType: 'native_organization', targetObjectId: organizationDomain, operator: 'eq' } }, options: shape === 'tight' ? { propertiesToReturn: ['body', 'date'], includeRelationships: false } : { propertiesToReturn: '*', includeRelationships: true } } },
    response: { status: 200, body: { native_context: { totalCount: notes.length, results: notes } } },
    latency_ms: Date.now() - t0,
  };
}

export const DAYAI_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'dayai_search_organization',
      description: 'Search the Day.ai CRM for an organization by name. Returns the organization record including relationships to contacts and recent notes.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dayai_get_contact',
      description: 'Get a single contact (Person) from Day.ai by email (objectId). Returns full person record including work experience and current role.',
      parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dayai_search_notes',
      description: 'Search Day.ai for recent notes (native_context) attached to an organization. Returns past touches and signals.',
      parameters: { type: 'object', properties: { organization_domain: { type: 'string' } }, required: ['organization_domain'] },
    },
  },
];

export async function execDayAiTool(name: string, args: Record<string, unknown>, account: string, shape: DayAiShape): Promise<DayAiApiCall> {
  switch (name) {
    case 'dayai_search_organization': return searchOrganization((args.name as string) ?? account, shape);
    case 'dayai_get_contact': return getContact(args.email as string, account, shape);
    case 'dayai_search_notes': return searchNotes((args.organization_domain as string) ?? '', account, shape);
    default: throw new Error(`unknown Day.ai tool: ${name}`);
  }
}
