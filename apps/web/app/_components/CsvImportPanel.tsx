'use client';

/**
 * CSV import UI: paste/upload a CSV, confirm the auto-guessed column mapping,
 * import. Rows become accounts + contacts (+ optional deals) via the same
 * idempotent ingest core, so this is safe to re-run and converges with
 * anything pushed later via the webhook. Shared between the workspace-creation
 * wizard (first-run) and Settings → Import (bring in more data later).
 */
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

// Header shapes that describe the person on the row, not the company —
// these default to 'contact' instead of 'account'.
const CONTACT_HINT = [/phone/i, /mobile/i, /\bcell\b/i, /personal.*email/i, /linkedin/i, /direct line/i, /\bfax\b/i];

// Header shapes that are either your own CRM housekeeping (not a fact about
// the prospect) or too identity-risky to save blindly (a "website" column
// that sometimes holds a personal profile link instead of the company's own
// site) — left off by default, still mappable by hand.
const SKIP_BY_DEFAULT = [
  /^owner$/i, /^status$/i, /outreach status/i, /^follow-?up$/i,
  /last contact/i, /last edited/i, /last modified/i, /priority tier/i,
  /^stage$/i, /website/i, /^url$/i, /web ?site/i,
];

function slugify(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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

interface FactMapping {
  predicate: string;
  on: 'account' | 'contact';
}

export interface ImportResult {
  accounts_created: number; accounts_reused: number;
  contacts_created: number; contacts_reused: number;
  opportunities_created: number; opportunities_updated: number;
  facts_asserted: number; signals_created: number;
  skipped: number; errors: string[];
}

export function CsvImportPanel({ workspaceId, onImported }: { workspaceId: string; onImported?: (result: ImportResult) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState('');
  const [dealsOn, setDealsOn] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseCsv(raw), [raw]);
  const { columns, rows } = parsed;

  const [mapping, setMapping] = useState<Mapping>({
    account_name: NONE, account_domain: NONE, contact_email: NONE, contact_name: NONE,
    contact_role: NONE, item_id: NONE, deal_external_id: NONE, deal_name: NONE,
    deal_stage: NONE, deal_value: NONE, deal_close_date: NONE,
  });
  // Regex header-matching is the instant baseline (renders before any network
  // round trip); the AI suggestion below overwrites it once it lands. The
  // model sees real sample values, not just header text, so it catches things
  // regex can't (a "Website" column that's actually full of company domains
  // in this file, even though "website" is regex-skipped by default).
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const latestColumnsKeyRef = useRef('');

  // Any column not already used by a fixed field above can still carry
  // signal (industry, size, notes, ...) — save it as a fact instead of
  // silently dropping it. Predicate empty = skip (the default for every
  // column, so nothing is saved unless the user opts in).
  const [factMap, setFactMap] = useState<Record<string, FactMapping>>({});
  const usedColumns = new Set(Object.values(mapping).filter((v) => v !== NONE));
  const extraColumns = columns.filter((c) => !usedColumns.has(c));
  const sampleValue = (col: string) => rows.find((r) => r[col])?.[col] ?? '';

  // Re-guess whenever the columns change (new paste/upload).
  const columnsKey = columns.join('|');
  useEffect(() => {
    if (columns.length === 0) return;
    const myKey = columnsKey;
    latestColumnsKeyRef.current = myKey;

    const guessed: Mapping = {
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
    };
    setMapping((m) => ({ ...m, ...guessed }));

    // Seed every leftover column with a suggested fact name + account/contact
    // guess, instead of leaving it blank — same guess-then-you-fix pattern as
    // the fixed fields above. Housekeeping/identity-risky headers stay blank
    // (opt-in), everything else is pre-filled (opt-out).
    const used = new Set(Object.values(guessed).filter((v) => v !== NONE));
    const seeded: Record<string, FactMapping> = {};
    for (const col of columns) {
      if (used.has(col)) continue;
      const skip = SKIP_BY_DEFAULT.some((p) => p.test(col));
      const onContact = CONTACT_HINT.some((p) => p.test(col));
      seeded[col] = { predicate: skip ? '' : slugify(col), on: onContact ? 'contact' : 'account' };
    }
    setFactMap(seeded);

    // Ask the model to do better than regex, using real sample values it
    // can't see from header text alone. Never blocks the baseline above —
    // if it fails or the file changes again before it returns, this is a
    // no-op and the regex guess stands.
    setSuggesting(true);
    setSuggestError(null);
    (async () => {
      try {
        const res = await fetch('/api/ingest/suggest-mapping', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId, columns, sample_rows: rows.slice(0, 20) }),
        });
        const j = await res.json();
        if (latestColumnsKeyRef.current !== myKey) return; // superseded by a newer file
        if (!res.ok || !j.suggestion) { setSuggestError(j.error ?? 'AI mapping suggestion failed'); return; }

        const s = j.suggestion as Record<string, unknown>;
        const aiMapping: Mapping = { ...guessed };
        (Object.keys(guessed) as (keyof Mapping)[]).forEach((k) => {
          const v = s[k];
          if (typeof v === 'string' && columns.includes(v)) aiMapping[k] = v;
        });
        setMapping((m) => ({ ...m, ...aiMapping }));

        const aiFactMap: Record<string, FactMapping> = { ...seeded };
        const facts = Array.isArray(s.facts) ? s.facts as Array<{ column?: unknown; predicate?: unknown; on?: unknown }> : [];
        for (const f of facts) {
          if (typeof f.column !== 'string' || !columns.includes(f.column)) continue;
          if (typeof f.predicate !== 'string' || !f.predicate.trim()) continue;
          aiFactMap[f.column] = { predicate: f.predicate, on: f.on === 'contact' ? 'contact' : 'account' };
        }
        setFactMap(aiFactMap);
      } catch (e) {
        if (latestColumnsKeyRef.current === myKey) setSuggestError(e instanceof Error ? e.message : String(e));
      } finally {
        if (latestColumnsKeyRef.current === myKey) setSuggesting(false);
      }
    })();
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
    const factMapEntries = Object.entries(factMap)
      .filter(([, f]) => f.predicate.trim().length > 0)
      .map(([column, f]) => ({ source_path: column, predicate: f.predicate.trim(), on: f.on }));
    if (factMapEntries.length) spec.fact_map = factMapEntries;
    return spec;
  }

  const canImport = rows.length > 0 && (mapping.account_name !== NONE || mapping.account_domain !== NONE || mapping.contact_email !== NONE) && !importing;

  // Send rows in batches instead of one request for the whole file: gives a
  // real progress readout (not just a spinner), and keeps every request well
  // under the API route's 300s ceiling regardless of how large the CSV is.
  const IMPORT_BATCH_SIZE = 150;
  const EMPTY_RESULT: ImportResult = {
    accounts_created: 0, accounts_reused: 0, contacts_created: 0, contacts_reused: 0,
    opportunities_created: 0, opportunities_updated: 0, facts_asserted: 0, signals_created: 0,
    skipped: 0, errors: [],
  };

  async function runImport() {
    setImporting(true); setResult(null); setError(null);
    setProgress({ done: 0, total: rows.length });
    const spec = buildSpec();
    const acc: ImportResult = { ...EMPTY_RESULT, errors: [] };
    try {
      for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
        const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
        const res = await fetch('/api/ingest/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId, rows: batch, spec }),
        });
        const j = await res.json();
        if (!res.ok) { setError(j.error ?? 'import failed'); return; }
        const r = j.result as ImportResult;
        acc.accounts_created += r.accounts_created; acc.accounts_reused += r.accounts_reused;
        acc.contacts_created += r.contacts_created; acc.contacts_reused += r.contacts_reused;
        acc.opportunities_created += r.opportunities_created; acc.opportunities_updated += r.opportunities_updated;
        acc.facts_asserted += r.facts_asserted; acc.signals_created += r.signals_created;
        acc.skipped += r.skipped; acc.errors.push(...r.errors);
        const done = Math.min(i + IMPORT_BATCH_SIZE, rows.length);
        setProgress({ done, total: rows.length });
        setResult({ ...acc });
      }
      onImported?.(acc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      setProgress(null);
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
      <div>
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
            {suggesting
              ? 'Suggesting a mapping from your column headers and sample values…'
              : 'AI-suggested from your headers and sample values. Adjust if needed.'}
            {' '}Need at least a company name, a domain, or an email.
            {suggestError && !suggesting && (
              <span style={{ color: 'var(--text-3)' }}> · AI suggestion unavailable ({suggestError}), using basic header matching.</span>
            )}
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

          {extraColumns.length > 0 && (
            <>
              <h3 style={{ marginTop: '1.5rem', marginBottom: '.5rem' }}>Other columns</h3>
              <p style={{ color: 'var(--text-3)', fontSize: '.78rem', marginTop: 0 }}>
                Anything left over is dropped unless you name it here — check the sample value before mapping a
                column; a header can be misleading (e.g. a "domain" column that's actually a category, or a
                "website" column that sometimes holds a social-profile link instead of the company's own site).
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr auto', gap: '.4rem .75rem', alignItems: 'center', fontSize: '.82rem' }}>
                <div style={{ ...label, marginBottom: 0 }}>Column</div>
                <div style={{ ...label, marginBottom: 0 }}>Sample value</div>
                <div style={{ ...label, marginBottom: 0 }}>Save as fact (blank = skip)</div>
                <div style={{ ...label, marginBottom: 0 }}>On</div>
                {extraColumns.map((col) => {
                  const entry = factMap[col] ?? { predicate: '', on: 'account' as const };
                  const update = (patch: Partial<FactMapping>) =>
                    setFactMap({ ...factMap, [col]: { ...entry, ...patch } });
                  return (
                    <div key={col} style={{ display: 'contents' }}>
                      <div style={{ color: 'var(--text)' }}>{col}</div>
                      <div style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sampleValue(col)}>
                        {sampleValue(col) || '—'}
                      </div>
                      <input
                        value={entry.predicate}
                        onChange={(e) => update({ predicate: e.target.value })}
                        placeholder="e.g. industry_category"
                        style={{ ...select, padding: '.3rem .5rem' }}
                      />
                      <select value={entry.on} onChange={(e) => update({ on: e.target.value as 'account' | 'contact' })} style={{ ...select, padding: '.3rem .5rem' }}>
                        <option value="account">account</option>
                        <option value="contact">contact</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ marginTop: '1.25rem' }}>
            <button
              onClick={runImport}
              disabled={!canImport}
              style={{ padding: '.5rem 1.1rem', border: 'none', borderRadius: 6, background: canImport ? 'var(--accent)' : 'var(--panel-2)', color: canImport ? 'var(--accent-fg)' : 'var(--text-3)', cursor: canImport ? 'pointer' : 'not-allowed', fontSize: '.9rem' }}
            >
              {importing ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
            </button>
          </div>

          {progress && (
            <div style={{ marginTop: '.75rem' }}>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 4, background: 'var(--accent)',
                  width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%`,
                  transition: 'width .2s ease',
                }} />
              </div>
              <div style={{ marginTop: '.35rem', fontSize: '.78rem', color: 'var(--text-3)' }}>
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()} rows
              </div>
            </div>
          )}
        </>
      )}

      {error && <div style={{ marginTop: '1rem', color: '#c0392b', fontSize: '.85rem' }}>✗ {error}</div>}

      {result && (
        <div style={{ marginTop: '1.25rem', padding: '.9rem 1.1rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel-2)' }}>
          <div style={{ fontWeight: 600, marginBottom: '.5rem' }}>{importing ? 'Importing…' : 'Import complete'}</div>
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
