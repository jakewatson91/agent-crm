/**
 * Twenty CRM side reader for v1 benchmark.
 *
 * Tool surface (mirrors what a Twenty agent dev would build given GraphQL
 * relations support bundled reads in one query):
 *   - twenty_get_company — single GraphQL query, returns company + people + notes
 *
 * Two shapes:
 *   - default: fetch a wide set of fields (most things a drafter might want)
 *   - tight:   minimal fields only
 *
 * This is the architecturally interesting test: does GraphQL bundling let
 * Twenty match agent-crm's "one read, one LLM call" pattern? If Twenty's
 * response is lean enough, it could be the only platform to challenge us.
 */

import type { Tool } from '../lib/llm.js';

const BASE = process.env.TWENTY_BASE_URL ?? 'http://localhost:3001';

export type TwentyShape = 'default' | 'tight';

export interface TwentyApiCall {
  tool: string;
  request: { method: string; url: string; body?: unknown };
  response: { status: number; body: unknown };
  latency_ms: number;
}

function getKey(): string {
  const k = process.env.TWENTY_API_KEY;
  if (!k) throw new Error('Missing TWENTY_API_KEY');
  return k;
}

async function twentyGraphQL(query: string, variables?: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}` },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const DEFAULT_QUERY = `query GetCompany($name: String!) {
  companies(filter: { name: { eq: $name } }, first: 1) {
    edges {
      node {
        id
        name
        domainName { primaryLinkUrl }
        employees
        annualRecurringRevenue { amountMicros currencyCode }
        idealCustomerProfile
        createdAt
        updatedAt
        people {
          edges {
            node {
              id
              name { firstName lastName }
              emails { primaryEmail }
              jobTitle
              createdAt
            }
          }
        }
        noteTargets {
          edges {
            node {
              note {
                id
                title
                bodyV2 { markdown }
                createdAt
                updatedAt
              }
            }
          }
        }
      }
    }
  }
}`;

const TIGHT_QUERY = `query GetCompany($name: String!) {
  companies(filter: { name: { eq: $name } }, first: 1) {
    edges {
      node {
        id
        name
        domainName { primaryLinkUrl }
        people {
          edges {
            node {
              id
              name { firstName lastName }
              emails { primaryEmail }
              jobTitle
            }
          }
        }
        noteTargets {
          edges {
            node {
              note { id title bodyV2 { markdown } }
            }
          }
        }
      }
    }
  }
}`;

export async function getCompany(name: string, shape: TwentyShape): Promise<TwentyApiCall> {
  const query = shape === 'tight' ? TIGHT_QUERY : DEFAULT_QUERY;
  const t0 = Date.now();
  const resp = await twentyGraphQL(query, { name });
  return {
    tool: 'twenty_get_company',
    request: { method: 'POST', url: `${BASE}/graphql`, body: { query, variables: { name } } },
    response: resp,
    latency_ms: Date.now() - t0,
  };
}

export const TWENTY_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'twenty_get_company',
      description: 'Fetch a Twenty company by name plus all associated people and notes in one nested GraphQL query.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
];

export async function execTwentyTool(name: string, args: Record<string, unknown>, shape: TwentyShape = 'default'): Promise<TwentyApiCall> {
  switch (name) {
    case 'twenty_get_company': return getCompany(args.name as string, shape);
    default: throw new Error(`unknown Twenty tool: ${name}`);
  }
}
