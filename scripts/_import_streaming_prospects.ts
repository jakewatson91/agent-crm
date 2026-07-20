/**
 * One-off: import Sudden's real prospect-list CSV (Notion export) into their
 * new workspace. Column-mapped by hand rather than through the shipped import
 * UI, because the UI's Mapping interface only exposes ~11 fixed fields and has
 * no fact_map control — the columns that actually carry signal for scoring
 * (Company description, Product, Country, Size, Business Models, Priority
 * Tier, Owner, ...) would be silently dropped if imported through the UI as-is.
 *
 * `Primary Domain` in this file is NOT a domain — it's an industry-category
 * label ("Media & Entertainment"); the real domain is in `Website`. Mapping
 * account_domain_path to Primary Domain would corrupt every account's
 * identity key and silently break domain-based dedupe.
 *
 * Idempotent via ingestRows: safe to re-run on an updated export.
 *
 * Usage: tsx scripts/_import_streaming_prospects.ts <workspace_id> <csv_path>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { ingestRows, type IngestSpec } from '@agent-crm/tools';

// Same minimal CSV parser as apps/web/app/workspace/[ws]/settings/import/page.tsx
// (pure string logic, no browser dependency — kept in sync by hand since the
// page component can't be imported into a node script).
function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.length) || row.length > 1) records.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); if (row.some((f) => f.length)) records.push(row); }
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0]!.map((h) => h.trim().replace(/^﻿/, ''));
  const rows = records.slice(1).map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((col, idx) => { o[col] = (r[idx] ?? '').trim(); });
    return o;
  });
  return { columns, rows };
}

const SPEC: IngestSpec = {
  account_name_path: 'Company name',
  account_domain_path: 'Website', // NOT "Primary Domain" — see header comment
  contact_name_path: 'Name',
  contact_role_path: 'Role',
  contact_email_path: 'Email',
  fact_map: [
    { source_path: 'Company description', predicate: 'description', on: 'account' },
    { source_path: 'Product', predicate: 'streaming_vertical', on: 'account' },
    { source_path: 'Primary Domain', predicate: 'industry_category', on: 'account' },
    { source_path: 'Country', predicate: 'hq_country', on: 'account' },
    { source_path: 'City', predicate: 'hq_city', on: 'account' },
    { source_path: 'Size', predicate: 'company_size', on: 'account' },
    { source_path: 'Business Models', predicate: 'business_model', on: 'account' },
    { source_path: 'Priority Tier', predicate: 'prior_priority_tier', on: 'account' },
    { source_path: 'Status', predicate: 'prior_status', on: 'account' },
    { source_path: 'Outreach Status', predicate: 'prior_outreach_status', on: 'account' },
    { source_path: 'Owner', predicate: 'prior_owner', on: 'account' },
    { source_path: 'Prospect notes', predicate: 'prior_notes', on: 'account' },
    { source_path: 'Linkedin URL', predicate: 'linkedin_url', on: 'contact' },
    { source_path: 'Phone #', predicate: 'phone', on: 'contact' },
    { source_path: 'Personal Email', predicate: 'personal_email', on: 'contact' },
  ],
  // Video Protocol / Cloud: 99%+ blank, no signal. Follow-up / Last contact /
  // Last Edited: stale state from a Notion workflow we're not continuing.
};

// A LinkedIn URL landed in the Name column on 4 rows (data-entry error) —
// treat as no-contact-name rather than importing a URL as a person's name.
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

async function main() {
  const workspaceId = process.argv[2];
  const csvPath = process.argv[3];
  if (!workspaceId || !csvPath) {
    console.error('usage: tsx scripts/_import_streaming_prospects.ts <workspace_id> <csv_path>');
    process.exit(1);
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const ws = await sb.from('workspaces').select('id, name').eq('id', workspaceId).maybeSingle();
  if (ws.error || !ws.data) throw new Error(`workspace ${workspaceId} not found: ${ws.error?.message}`);
  console.log(`workspace: ${ws.data.name} (${workspaceId})`);

  const text = readFileSync(csvPath, 'utf8');
  const { columns, rows: rawRows } = parseCsv(text);
  console.log(`parsed ${rawRows.length} rows, ${columns.length} columns`);

  let skippedUrlNames = 0;
  const rows = rawRows.map((r) => {
    if (looksLikeUrl(r['Name'] ?? '')) { skippedUrlNames++; return { ...r, Name: '' }; }
    return r;
  });
  console.log(`cleared ${skippedUrlNames} rows where Name held a LinkedIn URL instead of a person's name`);

  const CHUNK = 200;
  const total = {
    accounts_created: 0, accounts_reused: 0,
    contacts_created: 0, contacts_reused: 0,
    opportunities_created: 0, opportunities_updated: 0,
    facts_asserted: 0, signals_created: 0,
    skipped: 0, errors: [] as string[],
  };
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await ingestRows(sb, { workspace_id: workspaceId }, chunk, SPEC, {
      source_kind: 'import_csv',
      source_ref: 'notion-export-2026-07',
      source_label: 'Client prospect list import',
    });
    total.accounts_created += r.accounts_created;
    total.accounts_reused += r.accounts_reused;
    total.contacts_created += r.contacts_created;
    total.contacts_reused += r.contacts_reused;
    total.opportunities_created += r.opportunities_created;
    total.opportunities_updated += r.opportunities_updated;
    total.facts_asserted += r.facts_asserted;
    total.signals_created += r.signals_created;
    total.skipped += r.skipped;
    total.errors.push(...r.errors);
    console.log(`  rows ${i + 1}-${Math.min(i + CHUNK, rows.length)}: +${r.accounts_created} accounts, +${r.contacts_created} contacts, ${r.facts_asserted} facts, ${r.errors.length} errors`);
  }

  console.log('\n=== IngestResult (total) ===');
  console.log(JSON.stringify(total, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
