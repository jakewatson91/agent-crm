'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConnectorCard } from './ConnectorCard';
import { ConnectorModal } from './ConnectorModal';
import { ConnectedServices } from './ConnectedServices';

export interface ConnectorField {
  key: string; label: string; placeholder: string; help?: string;
  type?: 'secret' | 'text' | 'number'; optional?: boolean; policy_path?: string;
}
export interface ConnectorEntry {
  id: string; name: string; category: 'model' | 'contact' | 'research' | 'email';
  blurb: string; capabilities: string[]; get_key_url?: string;
  accent: 'blue' | 'green' | 'amber' | 'coral' | 'purple';
  fields: ConnectorField[]; provider_id?: string; verifiable?: boolean; model_hint?: string[];
  state: { configured: boolean; missing_keys: string[]; from_server: string[]; health: 'connected' | 'not_connected' | 'error'; role: 'primary' | 'fallback' | null; alert: { message: string } | null };
  values: Record<string, string>;
  saved: Record<string, boolean>;
}
interface Category { id: 'model' | 'contact' | 'research' | 'email'; label: string; hint: string }
/** One row in the model table. Shipped by the catalog API rather than imported,
 *  because the list lives in policy.ts and that file reaches node:crypto. */
export interface ModelBehaviorRow { key: string; label: string; hint: string }
interface Catalog {
  categories: Category[];
  connectors: ConnectorEntry[];
  model_behaviors: ModelBehaviorRow[];
  models: Record<string, string>;
  contact: { primary: string; fallback: string; daily_cap: number };
}

export function ConnectorHub({ workspace_id }: { workspace_id: string }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/connectors/catalog?workspace_id=${workspace_id}`);
    const j = await r.json();
    if (j.connectors) setCat(j);
  }, [workspace_id]);

  useEffect(() => { load(); }, [load]);

  if (!cat) return <p style={{ color: 'var(--text-3)' }}>loading connectors…</p>;

  const opened = cat.connectors.find((c) => c.id === open) ?? null;
  const anyIssue = cat.connectors.some((c) => c.state.health === 'error');
  const modelConnectors = cat.connectors.filter((c) => c.category === 'model');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <header>
        <h2 style={{ marginTop: 0, marginBottom: '.25rem' }}>Connectors</h2>
        <p style={{ fontSize: '.85rem', color: 'var(--text-2)', margin: 0, maxWidth: 640, lineHeight: 1.5 }}>
          The outside services your agent uses to think, find people, research, and send. Paste a key to turn one on.
          The agent picks the right one for each job on its own, and flags it here when a key stops working or credits run out.
        </p>
        {anyIssue && (
          <div style={{ marginTop: '.85rem', padding: '.6rem .85rem', borderRadius: 8, background: 'var(--accent-coral-soft)', color: '#a14d44', fontSize: '.8rem' }}>
            ⚠ One or more services need attention — look for the <strong>issue</strong> tag below.
          </div>
        )}
      </header>

      {cat.categories.map((category) => {
        const items = cat.connectors.filter((c) => c.category === category.id);
        if (items.length === 0) return null;
        return (
          <section key={category.id}>
            <div style={{ marginBottom: '.65rem' }}>
              <div style={{ fontSize: '.95rem', fontWeight: 600 }}>{category.label}</div>
              <div style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>{category.hint}</div>
            </div>
            <div style={grid}>
              {items.map((c) => (
                <ConnectorCard key={c.id} connector={c} onOpen={() => setOpen(c.id)} />
              ))}
            </div>
            {category.id === 'model' && (
              <DefaultModels workspace_id={workspace_id} behaviors={cat.model_behaviors ?? []} models={cat.models} connectors={modelConnectors} onSaved={load} />
            )}
            {category.id === 'contact' && (
              <ContactBudget workspace_id={workspace_id} dailyCap={cat.contact.daily_cap} onSaved={load} />
            )}
          </section>
        );
      })}

      <section>
        <div style={{ marginBottom: '.65rem' }}>
          <div style={{ fontSize: '.95rem', fontWeight: 600 }}>Connected apps</div>
          <div style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>
            Email, calendar, CRM, and chat the agent can read from. Connected by sign-in — no keys to paste.
          </div>
        </div>
        <ConnectedServices workspace_id={workspace_id} />
      </section>

      {opened && (
        <ConnectorModal
          connector={opened}
          workspace_id={workspace_id}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); load(); }}
        />
      )}
    </div>
  );
}

/**
 * Which model runs each behavior. Free text, one row per behavior, plus a
 * blanket row at the top.
 *
 * It was two boxes before, and the first was labelled "Default (scoring,
 * research, chat)". That label was wrong in both directions: the field reached
 * six more behaviors than it named, including the enricher, which is the
 * largest line on the bill — and it never reached research at all, because
 * those calls did not read workspace config. Naming every behavior is the fix,
 * so nobody has to guess what a box moves.
 */
function DefaultModels({
  workspace_id, behaviors, models, connectors, onSaved,
}: {
  workspace_id: string;
  behaviors: ModelBehaviorRow[];
  models: Record<string, string>;
  connectors: ConnectorEntry[];
  onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(models);
  const [focused, setFocused] = useState<string>('default');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const suggestions = Array.from(new Set(connectors.flatMap((c) => c.model_hint ?? [])));
  const set = (k: string, v: string) => setVals((p) => ({ ...p, [k]: v }));
  const blanket = vals.default ?? '';

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/connectors/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Every key goes up, including the blank ones — a blank is how you
        // clear a row back to the built-in default, so it has to be sent.
        body: JSON.stringify({
          workspace_id,
          models: Object.fromEntries([['default', blanket], ...behaviors.map((b) => [b.key, vals[b.key] ?? ''])]),
        }),
      });
      const j = await r.json();
      setMsg(r.ok ? 'saved' : (j.error ?? 'save failed'));
      if (r.ok) onSaved();
    } finally { setSaving(false); }
  }

  const row = (key: string, label: string, hint: string, placeholder: string) => (
    <label key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(9rem, 15rem) 1fr', gap: '.75rem', alignItems: 'baseline', padding: '.45rem 0', borderTop: key === 'default' ? 'none' : '1px solid var(--border)' }}>
      <span>
        <span style={{ display: 'block', fontSize: '.78rem', fontWeight: 500 }}>{label}</span>
        <span style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.35 }}>{hint}</span>
      </span>
      <input
        value={vals[key] ?? ''}
        onChange={(e) => set(key, e.target.value)}
        onFocus={() => setFocused(key)}
        placeholder={placeholder}
        style={modelInput}
      />
    </label>
  );

  return (
    <div style={{ marginTop: '1rem', padding: '.9rem 1rem', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)' }}>
      <div style={{ fontSize: '.85rem', fontWeight: 600 }}>Models</div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', margin: '.15rem 0 .75rem' }}>
        Pick a model per job. Leave a row blank and it follows the setting at the top; leave that blank too and it uses the built-in default. Any id from a connected provider works.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {row('default', 'Everything', 'Applies to every job below that you leave blank.', 'deepseek/deepseek-v4-pro')}
        {behaviors.map((b) => row(b.key, b.label, b.hint, blanket || 'built-in default'))}
      </div>
      {suggestions.length > 0 && (
        <div style={{ display: 'flex', gap: '.3rem', flexWrap: 'wrap', marginTop: '.6rem', alignItems: 'center' }}>
          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>paste into {focused === 'default' ? 'Everything' : (behaviors.find((b) => b.key === focused)?.label ?? focused)}:</span>
          {suggestions.map((s) => (
            <button key={s} onClick={() => set(focused, s)} style={chip}>{s}</button>
          ))}
        </div>
      )}
      <div style={{ marginTop: '.85rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <button onClick={save} disabled={saving} style={{ padding: '.45rem 1rem', background: 'var(--accent-green)', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}>
          {saving ? 'saving…' : 'Save models'}
        </button>
        {msg && <span style={{ fontSize: '.78rem', color: msg === 'saved' ? '#5a7e5f' : '#a14d44' }}>{msg === 'saved' ? '✓ saved' : msg}</span>}
      </div>
    </div>
  );
}

/** Daily cap on Hunter/Explorium lookups the advance pass may spend — shared across whichever provider is active, so it lives here rather than on one connector's card. */
function ContactBudget({
  workspace_id, dailyCap, onSaved,
}: {
  workspace_id: string;
  dailyCap: number;
  onSaved: () => void;
}) {
  const [cap, setCap] = useState(dailyCap);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/connectors/contact-budget', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, max_contact_pulls_per_run: cap }),
      });
      const j = await r.json();
      setMsg(r.ok ? 'saved' : (j.error ?? 'save failed'));
      if (r.ok) onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div style={{ marginTop: '1rem', padding: '.9rem 1rem', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)' }}>
      <div style={{ fontSize: '.85rem', fontWeight: 600 }}>Daily contact budget</div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', margin: '.15rem 0 .75rem' }}>
        How many accounts the daily pass may spend a contact-provider lookup on, whichever source above is active. 0 disables lookups. Separate from each provider's own monthly cap.
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '.2rem', maxWidth: 160 }}>
        <span style={{ fontSize: '.78rem', fontWeight: 500 }}>Lookups per daily run</span>
        <input
          type="number" min={0} value={cap}
          onChange={(e) => setCap(parseInt(e.target.value, 10) || 0)}
          style={modelInput}
        />
      </label>
      <div style={{ marginTop: '.85rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <button onClick={save} disabled={saving} style={{ padding: '.45rem 1rem', background: 'var(--accent-green)', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}>
          {saving ? 'saving…' : 'Save'}
        </button>
        {msg && <span style={{ fontSize: '.78rem', color: msg === 'saved' ? '#5a7e5f' : '#a14d44' }}>{msg === 'saved' ? '✓ saved' : msg}</span>}
      </div>
    </div>
  );
}

const grid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '.75rem',
};
const modelInput: React.CSSProperties = {
  padding: '.45rem .6rem', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 6, fontSize: '.82rem', fontFamily: 'var(--font-mono)', width: '100%',
};
const chip: React.CSSProperties = {
  padding: '.2rem .55rem', fontSize: '.7rem', borderRadius: 999, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
};
