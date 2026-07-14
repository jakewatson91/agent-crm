/**
 * CSV column → field mapping, via one LLM call instead of regex header
 * matching. Regex only sees the header text ("Website" always guesses
 * account_domain, even when the column is actually full of personal LinkedIn
 * URLs); the model sees a few real sample values per column too, so it can
 * catch the cases regex can't. Same shape as classify_role.ts: one small,
 * cheap, structured-JSON call, never a critic/judge/agent.
 *
 * Cost is bounded by column count, not row count — a 50-column file and a
 * 50,000-row file with the same 50 columns cost the same one call.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace } from './chat_workspace.ts';

const MAPPING_MODEL = 'deepseek-v4-flash';

const FIXED_FIELDS = [
  'account_name', 'account_domain', 'contact_email', 'contact_name', 'contact_role', 'item_id',
  'deal_external_id', 'deal_name', 'deal_stage', 'deal_value', 'deal_close_date',
] as const;
type FixedField = typeof FIXED_FIELDS[number];

export interface SuggestedFact {
  column: string;
  predicate: string;
  on: 'account' | 'contact';
}

export type SuggestedMapping = Record<FixedField, string | null> & { facts: SuggestedFact[] };

const EMPTY_MAPPING: SuggestedMapping = {
  account_name: null, account_domain: null, contact_email: null, contact_name: null,
  contact_role: null, item_id: null, deal_external_id: null, deal_name: null,
  deal_stage: null, deal_value: null, deal_close_date: null, facts: [],
};

const SYSTEM_PROMPT = `You map spreadsheet column headers from a CRM data export to a fixed set of target fields. You're given each column's header and a few real sample values from that column — read the samples, not just the header name, because a header can lie (a "Website" column sometimes holds a personal LinkedIn URL instead of the company's own site; a "Domain" column can hold a category label by mistake).

Fixed targets — assign each to at most one column, or null if no column fits:
- account_name     company / organization name
- account_domain   the company's OWN website domain (never a linkedin.com/facebook.com/twitter.com/x.com/instagram.com profile link)
- contact_email
- contact_name     the person's name (not the company name)
- contact_role     job title / position
- item_id          a stable per-row id (record id, external id) — only if the file clearly has one
- deal_external_id, deal_name, deal_stage, deal_value, deal_close_date — deal/opportunity fields, only if this file tracks deals at all

Every column NOT used as a fixed target should be classified as a fact or skipped:
- fact: the column carries real signal about the company or the person (industry, employee count, LinkedIn URL, phone, notes, tags, funding stage, ...). Give it a short snake_case predicate name and say whether it describes the account or the contact.
- skip (leave out of "facts"): pure CRM housekeeping with no signal about the company/person (an owner/rep name, a UI-only status or stage-tracking field, a "last contacted" timestamp, a duplicate of a column already used as a fixed target).

Output strictly valid JSON, no prose, no markdown fences:
{"account_name":"<header or null>","account_domain":"<header or null>","contact_email":"<header or null>","contact_name":"<header or null>","contact_role":"<header or null>","item_id":"<header or null>","deal_external_id":"<header or null>","deal_name":"<header or null>","deal_stage":"<header or null>","deal_value":"<header or null>","deal_close_date":"<header or null>","facts":[{"column":"<header>","predicate":"<snake_case>","on":"account"|"contact"}]}`;

function buildUserPrompt(columns: string[], sampleRows: Record<string, string>[]): string {
  const lines = columns.map((col, i) => {
    const samples = sampleRows
      .map((r) => r[col])
      .filter((v): v is string => Boolean(v && v.trim()))
      .slice(0, 3);
    return `${i + 1}. "${col}" — samples: ${samples.length ? samples.map((s) => JSON.stringify(s)).join(', ') : '(no non-empty values seen)'}`;
  });
  return `columns:\n${lines.join('\n')}`;
}

function slugify(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Ask the model to map every column in one shot. Returns EMPTY_MAPPING (all
 * nulls, no facts) on any failure — caller falls back to its own heuristic
 * rather than blocking the import wizard on an LLM hiccup.
 */
export async function suggestColumnMapping(
  sb: SupabaseClient,
  workspace_id: string,
  columns: string[],
  sampleRows: Record<string, string>[],
): Promise<SuggestedMapping> {
  if (columns.length === 0) return EMPTY_MAPPING;

  let parsed: Record<string, unknown>;
  try {
    const llm = await chatCompleteForWorkspace(sb, workspace_id, {
      model: MAPPING_MODEL,
      behavior: 'wizard',
      max_tokens: Math.max(400, columns.length * 40),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(columns, sampleRows.slice(0, 20)) },
      ],
    });
    parsed = JSON.parse(llm.text);
  } catch {
    return EMPTY_MAPPING;
  }

  const columnSet = new Set(columns);
  const out: SuggestedMapping = { ...EMPTY_MAPPING, facts: [] };
  const claimed = new Set<string>();

  for (const field of FIXED_FIELDS) {
    const v = parsed[field];
    if (typeof v === 'string' && columnSet.has(v) && !claimed.has(v)) {
      out[field] = v;
      claimed.add(v);
    }
  }

  if (Array.isArray(parsed.facts)) {
    for (const f of parsed.facts) {
      if (!f || typeof f !== 'object') continue;
      const column = (f as { column?: unknown }).column;
      const predicate = (f as { predicate?: unknown }).predicate;
      const on = (f as { on?: unknown }).on;
      if (typeof column !== 'string' || !columnSet.has(column) || claimed.has(column)) continue;
      if (typeof predicate !== 'string' || !predicate.trim()) continue;
      claimed.add(column);
      out.facts.push({ column, predicate: slugify(predicate), on: on === 'contact' ? 'contact' : 'account' });
    }
  }

  return out;
}
