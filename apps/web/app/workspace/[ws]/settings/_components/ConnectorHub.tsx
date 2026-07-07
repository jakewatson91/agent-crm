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
interface Catalog {
  categories: Category[];
  connectors: ConnectorEntry[];
  models: { default_chat_model: string; drafter_model: string };
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
              <DefaultModels workspace_id={workspace_id} models={cat.models} connectors={modelConnectors} onSaved={load} />
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

/** Which model id runs chat/scoring vs the customer-facing drafts. Free text. */
function DefaultModels({
  workspace_id, models, connectors, onSaved,
}: {
  workspace_id: string;
  models: { default_chat_model: string; drafter_model: string };
  connectors: ConnectorEntry[];
  onSaved: () => void;
}) {
  const [def, setDef] = useState(models.default_chat_model);
  const [drafter, setDrafter] = useState(models.drafter_model);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const suggestions = Array.from(new Set(connectors.flatMap((c) => c.model_hint ?? [])));

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/connectors/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, default_chat_model: def, drafter_model: drafter }),
      });
      const j = await r.json();
      setMsg(r.ok ? 'saved' : (j.error ?? 'save failed'));
      if (r.ok) onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div style={{ marginTop: '1rem', padding: '.9rem 1rem', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)' }}>
      <div style={{ fontSize: '.85rem', fontWeight: 600 }}>Default models</div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', margin: '.15rem 0 .75rem' }}>
        Which model runs each job. Leave blank to use the built-in default. Any id above works.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
          <span style={{ fontSize: '.78rem', fontWeight: 500 }}>Default (scoring, research, chat)</span>
          <input value={def} onChange={(e) => setDef(e.target.value)} placeholder="deepseek/deepseek-v4-pro" style={modelInput} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
          <span style={{ fontSize: '.78rem', fontWeight: 500 }}>Drafter (writes your outbound)</span>
          <input value={drafter} onChange={(e) => setDrafter(e.target.value)} placeholder="same as default" style={modelInput} />
        </label>
      </div>
      {suggestions.length > 0 && (
        <div style={{ display: 'flex', gap: '.3rem', flexWrap: 'wrap', marginTop: '.6rem' }}>
          {suggestions.map((s) => (
            <button key={s} onClick={() => setDef(s)} style={chip}>{s}</button>
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
