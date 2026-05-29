'use client';

/**
 * One-time CSV import. Bring an old CRM (or any export) in: paste/upload a CSV,
 * confirm the auto-guessed column mapping, import. Rows become accounts +
 * contacts (+ optional deals) via the same idempotent ingest core, so this is
 * safe to re-run and converges with anything pushed later via the webhook.
 */
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

// Minimal CSV parser: handles quoted fields, embedded commas/quotes, CRLF.
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
  const columns = records[0]!.map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((col, idx) => { o[col] = (r[idx] ?? '').trim(); });
    return o;
  });
  return { columns, rows };
}

const NONE = '';

// Auto-guess which column maps to each field from the header name.
function guess(columns: string[], patterns: RegExp[]): string {
  for (const p of patterns) {
    const hit = columns.find((c) => p.test(c));
    if (hit) return hit;
  }
  return NONE;
}

interface Mapping {
  account_name: string;
  account_domain: string;
  contact_email: string;
  contact_name: string;
  contact_role: string;
  item_id: string;
  // deal
  deal_external_id: string;
  deal_name: string;
  deal_stage: string;
  deal_value: string;
  deal_close_date: string;
}

interface ImportResult {
  accounts_created: number; accounts_reused: number;
  contacts_created: number; contacts_reused: number;
  opportunities_created: number; opportunities_updated: number;
  facts_asserted: number; signals_created: number;
  skipped: number; errors: string[];
}

export default function ImportPage() {
  const params = useParams<{ ws: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState('');
  const [dealsOn, setDealsOn] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseCsv(raw), [raw]);
  const { columns, rows } = parsed;

  const [mapping, setMapping] = useState<Mapping>({
    account_name: NONE, account_domain: NONE, contact_email: NONE, contact_name: NONE,
    contact_role: NONE, item_id: NONE, deal_external_id: NONE, deal_name: NONE,
    deal_stage: NONE, deal_value: NONE, deal_close_date: NONE,
  });

  // Re-guess whenever the columns change (new paste/upload).
  const columnsKey = columns.join('|');
  useEffect(() => {
    if (columns.length === 0) return;
    setMapping((m) => ({
      ...m,
      account_name: guess(columns, [/^company( name)?$/i, /^account( name)?$/i, /^organization$/i, /company/i]),
      account_domain: guess(columns, [/domain/i, /website/i, /^url$/i, /web ?site/i]),
      contact_email: guess(columns, [/e-?mail/i]),
      contact_name: guess(columns, [/^(contact|full|person|first)?\s*name$/i, /contact name/i, /full name/i]),
      contact_role: guess(columns, [/title/i, /role/i, /position/i, /job/i]),
      item_id: guess(columns, [/^id$/i, /record id/i, /_id$/i]),
      deal_external_id: guess(columns, [/deal id/i, /opportunity id/i, /^id$/i]),
      deal_name: guess(columns, [/deal name/i, /opportunity name/i, /^deal$/i]),
      deal_stage: guess(columns, [/stage/i, /deal status/i]),
      deal_value: guess(columns, [/amount/i, /value/i, /deal size/i]),
      deal_close_date: guess(columns, [/close date/i, /closing/i, /expected close/i]),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setRaw(String(reader.result ?? '')); setResult(null); setError(null); };
    reader.readAsText(f);
  }

  function buildSpec() {
    const spec: Record<string, unknown> = {};
    if (mapping.account_name) spec.account_name_path = mapping.account_name;
    if (mapping.account_domain) spec.account_domain_path = mapping.account_domain;
    if (mapping.contact_email) spec.contact_email_path = mapping.contact_email;
    if (mapping.contact_name) spec.contact_name_path = mapping.contact_name;
    if (mapping.contact_role) spec.contact_role_path = mapping.contact_role;
    if (mapping.item_id) spec.item_id_path = mapping.item_id;
    if (dealsOn) {
      const deal: Record<string, unknown> = {};
      if (mapping.deal_external_id) deal.external_id_path = mapping.deal_external_id;
      if (mapping.deal_name) deal.name_path = mapping.deal_name;
      if (mapping.deal_stage) deal.stage_path = mapping.deal_stage;
      if (mapping.deal_value) deal.value_path = mapping.deal_value;
      if (mapping.deal_close_date) deal.close_date_path = mapping.deal_close_date;
      if (Object.keys(deal).length) spec.deal = deal;
    }
    return spec;
  }

  const canImport = rows.length > 0 && (mapping.account_name !== NONE || mapping.account_domain !== NONE || mapping.contact_email !== NONE) && !importing;

  async function runImport() {
    setImporting(true); setResult(null); setError(null);
    try {
      const res = await fetch('/api/ingest/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws, rows, spec: buildSpec() }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'import failed'); return; }
      setResult(j.result as ImportResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  const label: React.CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', display: 'block', marginBottom: '.2rem' };
  const select: React.CSSProperties = { width: '100%', padding: '.4rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel)', color: 'var(--text)', fontSize: '.85rem' };

  const fieldRow = (key: keyof Mapping, text: string, hint?: string) => (
    <div style={{ marginBottom: '.6rem' }}>
      <label style={label}>{text}{hint ? <span style={{ color: 'var(--text-3)' }}> · {hint}</span> : null}</label>
      <select value={mapping[key]} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })} style={select}>
        <option value={NONE}>— none —</option>
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Import from a CSV</h2>
      <p style={{ color: 'var(--text-2)', fontSize: '.9rem', marginTop: '.4rem' }}>
        One-time migration: export your old CRM (or any spreadsheet) to CSV and bring it in. Rows become
        accounts and contacts here, and the agent runs on them. Safe to re-run — duplicates are merged, not
        re-created. For ongoing data, point a tool at your <strong>inbound webhook</strong> source instead.
      </p>

      <div style={{ marginTop: '1.25rem' }}>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
        <button onClick={() => fileRef.current?.click()} style={{ padding: '.45rem .9rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel-2)', color: 'var(--text)', cursor: 'pointer', fontSize: '.85rem' }}>
          Choose CSV file…
        </button>
        <span style={{ color: 'var(--text-3)', fontSize: '.8rem', marginLeft: '.6rem' }}>or paste below</span>
        <textarea
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setResult(null); setError(null); }}
          rows={5}
          placeholder={'company,domain,email,title\nAcme,acme.com,jane@acme.com,VP Sales'}
          style={{ width: '100%', marginTop: '.6rem', padding: '.6rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel)', color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', fontSize: '.8rem' }}
        />
      </div>

      {columns.length > 0 && (
        <>
          <div style={{ marginTop: '.5rem', fontSize: '.8rem', color: 'var(--text-2)' }}>
            Detected <strong>{rows.length}</strong> row{rows.length === 1 ? '' : 's'}, <strong>{columns.length}</strong> column{columns.length === 1 ? '' : 's'}.
          </div>

          <h3 style={{ marginTop: '1.5rem', marginBottom: '.5rem' }}>Map columns</h3>
          <p style={{ color: 'var(--text-3)', fontSize: '.78rem', marginTop: 0 }}>
            We guessed these from your headers. Adjust if needed. Need at least a company name, a domain, or an email.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1.25rem' }}>
            {fieldRow('account_name', 'Account name')}
            {fieldRow('account_domain', 'Account domain')}
            {fieldRow('contact_email', 'Contact email')}
            {fieldRow('contact_name', 'Contact name')}
            {fieldRow('contact_role', 'Contact role / title')}
            {fieldRow('item_id', 'Row id', 'for dedup, optional')}
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label style={{ fontSize: '.85rem', color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <input type="checkbox" checked={dealsOn} onChange={(e) => setDealsOn(e.target.checked)} />
              This CSV has deals / opportunities
            </label>
          </div>
          {dealsOn && (
            <div style={{ marginTop: '.6rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1.25rem', paddingLeft: '1rem', borderLeft: '2px solid var(--border)' }}>
              {fieldRow('deal_external_id', 'Deal id', 'stable key across re-imports')}
              {fieldRow('deal_name', 'Deal name')}
              {fieldRow('deal_stage', 'Stage')}
              {fieldRow('deal_value', 'Amount / value')}
              {fieldRow('deal_close_date', 'Close date')}
            </div>
          )}

          <div style={{ marginTop: '1.25rem' }}>
            <button
              onClick={runImport}
              disabled={!canImport}
              style={{ padding: '.5rem 1.1rem', border: 'none', borderRadius: 6, background: canImport ? 'var(--accent, #2563eb)' : 'var(--panel-2)', color: canImport ? '#fff' : 'var(--text-3)', cursor: canImport ? 'pointer' : 'not-allowed', fontSize: '.9rem' }}
            >
              {importing ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}

      {error && <div style={{ marginTop: '1rem', color: '#c0392b', fontSize: '.85rem' }}>✗ {error}</div>}

      {result && (
        <div style={{ marginTop: '1.25rem', padding: '.9rem 1.1rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel-2)' }}>
          <div style={{ fontWeight: 600, marginBottom: '.5rem' }}>Import complete</div>
          <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '.85rem', color: 'var(--text-2)' }}>
            <span>Accounts: <strong>{result.accounts_created}</strong> new, {result.accounts_reused} reused</span>
            <span>Contacts: <strong>{result.contacts_created}</strong> new, {result.contacts_reused} reused</span>
            {(result.opportunities_created > 0 || result.opportunities_updated > 0) && (
              <span>Deals: <strong>{result.opportunities_created}</strong> new, {result.opportunities_updated} updated</span>
            )}
            <span>Facts: {result.facts_asserted}</span>
            <span>Signals: {result.signals_created}</span>
            {result.skipped > 0 && <span>Skipped: {result.skipped}</span>}
          </div>
          {result.errors.length > 0 && (
            <div style={{ marginTop: '.6rem', fontSize: '.8rem', color: '#c0392b' }}>
              {result.errors.slice(0, 8).map((e, i) => <div key={i}>· {e}</div>)}
              {result.errors.length > 8 && <div>· …and {result.errors.length - 8} more</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
