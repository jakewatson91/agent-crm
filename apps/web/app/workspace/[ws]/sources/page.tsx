'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Timestamp } from '../../../_components/Timestamp';

interface ConnectorMeta {
  type: string;
  label: string;
  description: string;
  category?: 'tool' | 'preset';
  schedule_cron: string;
  config_schema: { fields: Array<{ name: string; label: string; kind: string; required?: boolean; help?: string; default?: unknown }> };
}
interface Source {
  id: string;
  connector_type: string;
  name: string;
  config: Record<string, unknown>;
  schedule_cron: string;
  active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary: { signals_created?: number; entities_created?: number; skipped?: number; errors?: string[]; signals_7d?: number } | null;
  created_at: string;
}
interface Entity { id: string; name: string; kind: string }

export default function SourcesPage() {
  const params = useParams<{ ws: string }>();
  const [connectors, setConnectors] = useState<ConnectorMeta[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [picked, setPicked] = useState<ConnectorMeta | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRunResult, setLastRunResult] = useState<{ source_id: string; ok: boolean; summary: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nlDescription, setNlDescription] = useState('');
  const [parsing, setParsing] = useState(false);
  const [metaTokens, setMetaTokens] = useState<{ input: number; output: number } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function loadAll() {
    const [cRes, sRes, eRes] = await Promise.all([
      fetch('/api/sources/connectors').then((r) => r.json()),
      fetch(`/api/sources/list?workspace_id=${params.ws}`).then((r) => r.json()),
      fetch(`/api/entities/list?workspace_id=${params.ws}`).then((r) => r.json()),
    ]);
    setConnectors(cRes.connectors ?? []);
    setSources(sRes.sources ?? []);
    setEntities(eRes.entities ?? []);
  }
  useEffect(() => { loadAll(); }, [params.ws]);

  function pick(c: ConnectorMeta) {
    setPicked(c);
    setError(null);
    const initial: Record<string, unknown> = {};
    for (const f of c.config_schema.fields) {
      if (f.default !== undefined) initial[f.name] = f.default;
    }
    setDraftConfig(initial);
    setDraftName(`${c.type}_${Date.now().toString(36).slice(-4)}`);
    setMetaTokens(null);
  }

  async function nlParse() {
    if (!nlDescription.trim()) return;
    setError(null); setParsing(true); setMetaTokens(null); setWarnings([]);
    try {
      const res = await fetch('/api/sources/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: nlDescription, workspace_id: params.ws }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'parse failed'); return; }
      const draft = j.parsed as { connector_type: string; name: string; config: Record<string, unknown> };
      const conn = connectors.find((c) => c.type === draft.connector_type);
      if (!conn) { setError(`meta-agent picked unknown connector "${draft.connector_type}"`); return; }
      setPicked(conn);
      setDraftName(draft.name || `${conn.type}_${Date.now().toString(36).slice(-4)}`);
      setDraftConfig(draft.config ?? {});
      setMetaTokens(j.meta_tokens ?? null);
      setWarnings(j.warnings ?? []);
    } finally {
      setParsing(false);
    }
  }

  async function create() {
    if (!picked) return;
    setError(null); setCreating(true);
    try {
      const res = await fetch('/api/sources/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: params.ws,
          connector_type: picked.type,
          name: draftName,
          config: draftConfig,
        }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'create failed'); return; }
      setPicked(null); setDraftName(''); setDraftConfig({});
      await loadAll();
    } finally {
      setCreating(false);
    }
  }

  async function runNow(source_id: string) {
    setRunning(source_id); setLastRunResult(null);
    try {
      const res = await fetch('/api/sources/run-now', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id }),
      });
      const j = await res.json();
      setLastRunResult({ source_id, ok: j.ok, summary: j.summary ?? j });
      await loadAll();
    } finally {
      setRunning(null);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '.5rem', background: '#0a0a0a', color: '#e5e5e5',
    border: '1px solid #1f1f1f', fontFamily: 'inherit', fontSize: '.85rem',
  };
  const labelStyle: React.CSSProperties = { fontSize: '.75rem', color: '#888', marginBottom: '.25rem', display: 'block' };

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Sources</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>
        Where signals come from. Each source is a configured ingest worker that runs on a schedule and creates
        signals via the same tools agents use.
      </p>
      {(() => {
        const active = sources.filter((s) => s.active);
        const errored = active.filter((s) => s.last_run_status === 'error');
        const silent = active.filter((s) => s.last_run_status === 'ok' && (s.last_run_summary?.signals_7d ?? 0) === 0);
        const producing = active.length - errored.length - silent.length;
        const paused = sources.length - active.length;
        const chipBase: React.CSSProperties = { padding: '.25rem .55rem', borderRadius: 4, fontSize: '.75rem', border: '1px solid' };
        return (
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.75rem', flexWrap: 'wrap' }}>
            <span style={{ ...chipBase, borderColor: '#9ece6a', color: '#9ece6a' }}>{producing} producing</span>
            <span style={{ ...chipBase, borderColor: silent.length ? '#e0c080' : '#444', color: silent.length ? '#e0c080' : '#666' }}>{silent.length} silent (0 signals 7d)</span>
            <span style={{ ...chipBase, borderColor: errored.length ? '#f7768e' : '#444', color: errored.length ? '#f7768e' : '#666' }}>{errored.length} errored</span>
            <span style={{ ...chipBase, borderColor: '#444', color: '#666' }}>{paused} paused</span>
          </div>
        );
      })()}

      <div style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid #1f1f1f', background: '#0a0a0a' }}>
        <div style={labelStyle}>describe a source in plain English</div>
        <div style={{ fontSize: '.75rem', color: '#666', marginBottom: '.5rem' }}>
          The meta-agent picks the right connector type and pre-fills the config. You review and edit before creating.
        </div>
        <textarea
          value={nlDescription}
          onChange={(e) => setNlDescription(e.target.value)}
          rows={2}
          placeholder='e.g. "watch HN for AI CRM mentions" or "the Lenny&apos;s Newsletter Substack"'
          style={inputStyle}
        />
        <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <button
            onClick={nlParse}
            disabled={parsing || !nlDescription.trim()}
            style={{ padding: '.4rem .9rem', background: '#7aa2f7', color: '#000', border: 'none', cursor: 'pointer', opacity: parsing || !nlDescription.trim() ? 0.4 : 1, fontSize: '.85rem' }}
          >
            {parsing ? 'parsing…' : 'parse with meta-agent'}
          </button>
          {metaTokens && <span style={{ fontSize: '.75rem', color: '#666' }}>· {metaTokens.input}in / {metaTokens.output}out tokens</span>}
        </div>
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <div style={labelStyle}>or pick a connector directly</div>
        <div style={{ fontSize: '.7rem', color: '#888', marginTop: '.25rem', marginBottom: '.5rem' }}>Tools — generic capabilities you fill from scratch</div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          {connectors.filter((c) => c.category === 'tool').map((c) => (
            <button
              key={c.type}
              onClick={() => pick(c)}
              title={c.description}
              style={{
                padding: '.5rem .75rem',
                background: picked?.type === c.type ? '#7aa2f7' : '#1f1f1f',
                color: picked?.type === c.type ? '#000' : '#e5e5e5',
                border: 'none', cursor: 'pointer', fontSize: '.85rem',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: '.7rem', color: '#888', marginTop: '1rem', marginBottom: '.5rem' }}>Presets — one-click for known sources</div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          {connectors.filter((c) => c.category !== 'tool').map((c) => (
            <button
              key={c.type}
              onClick={() => pick(c)}
              title={c.description}
              style={{
                padding: '.5rem .75rem',
                background: picked?.type === c.type ? '#7aa2f7' : '#1f1f1f',
                color: picked?.type === c.type ? '#000' : '#e5e5e5',
                border: 'none', cursor: 'pointer', fontSize: '.85rem',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {connectors.length === 0 && <span style={{ color: '#666', fontSize: '.85rem' }}>no connectors registered</span>}
      </div>

      {picked && (
        <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #1f1f1f', background: '#0a0a0a' }}>
          <div style={{ fontSize: '.85rem', color: '#999' }}>{picked.description}</div>
          <div style={{ fontSize: '.75rem', color: '#666', marginTop: '.25rem' }}>schedule: {picked.schedule_cron}</div>

          <div style={{ marginTop: '1rem' }}>
            <label style={labelStyle}>source name (label)</label>
            <input value={draftName} onChange={(e) => setDraftName(e.target.value)} style={inputStyle} />
          </div>

          {picked.config_schema.fields.map((f) => (
            <div key={f.name} style={{ marginTop: '.75rem' }}>
              <label style={labelStyle}>{f.label}{f.required ? ' *' : ''}</label>
              {f.help && <div style={{ fontSize: '.75rem', color: '#666', marginBottom: '.25rem' }}>{f.help}</div>}
              {renderField(f, draftConfig[f.name], (v) => setDraftConfig({ ...draftConfig, [f.name]: v }), entities, inputStyle)}
            </div>
          ))}

          {(() => {
            const knownFields = new Set(picked.config_schema.fields.map((f) => f.name));
            const extras = Object.keys(draftConfig).filter((k) => !knownFields.has(k));
            if (extras.length === 0) return null;
            return (
              <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px dashed #1f1f1f' }}>
                <div style={{ fontSize: '.75rem', color: '#888', marginBottom: '.5rem' }}>
                  custom fields the meta-agent added (edit as JSON):
                </div>
                {extras.map((key) => (
                  <div key={key} style={{ marginTop: '.5rem' }}>
                    <label style={labelStyle}>{key}</label>
                    <textarea
                      value={typeof draftConfig[key] === 'string' ? (draftConfig[key] as string) : JSON.stringify(draftConfig[key], null, 2)}
                      onChange={(e) => {
                        let parsed: unknown = e.target.value;
                        try { parsed = JSON.parse(e.target.value); } catch { /* leave as string */ }
                        setDraftConfig({ ...draftConfig, [key]: parsed });
                      }}
                      rows={2}
                      style={{ ...inputStyle, fontFamily: 'monospace' }}
                    />
                  </div>
                ))}
                <div style={{ marginTop: '.25rem', fontSize: '.7rem', color: '#666' }}>
                  Note: connector code only reads fields it knows about. Extras are stored on the source row and useful for documenting intent.
                </div>
              </div>
            );
          })()}

          {warnings.length > 0 && (
            <div style={{ marginTop: '.75rem', padding: '.5rem .75rem', background: '#1a1610', border: '1px solid #4a3a1a', fontSize: '.8rem', color: '#e0c080' }}>
              {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}

          {error && <div style={{ marginTop: '.75rem', color: '#f7768e', fontSize: '.85rem' }}>✗ {error}</div>}

          <div style={{ marginTop: '1rem', display: 'flex', gap: '.5rem' }}>
            <button onClick={create} disabled={creating || !draftName.trim()} style={{ padding: '.5rem 1rem', background: '#9ece6a', color: '#000', border: 'none', cursor: 'pointer', opacity: creating || !draftName.trim() ? 0.4 : 1 }}>
              {creating ? 'creating…' : 'create'}
            </button>
            <button onClick={() => { setPicked(null); setError(null); }} style={{ padding: '.5rem 1rem', background: '#1f1f1f', color: '#e5e5e5', border: 'none', cursor: 'pointer' }}>cancel</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: '2rem' }}>
        <div style={{ fontSize: '.85rem', color: '#999', marginBottom: '.75rem' }}>
          {sources.length} configured source{sources.length === 1 ? '' : 's'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          {sources.map((s) => (
            <div key={s.id} style={{ padding: '.75rem 1rem', border: '1px solid #1f1f1f', background: s.active ? 'transparent' : '#0a0a0a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontSize: '.95rem', color: '#e5e5e5', fontFamily: 'monospace' }}>{s.connector_type} · {s.name}</div>
                  <div style={{ fontSize: '.75rem', color: '#666' }}>{s.schedule_cron} · {s.active ? 'active' : 'paused'}</div>
                </div>
                <button onClick={() => runNow(s.id)} disabled={running === s.id} style={{ padding: '.4rem .75rem', background: '#7aa2f7', color: '#000', border: 'none', cursor: 'pointer', fontSize: '.8rem' }}>
                  {running === s.id ? 'running…' : 'run now'}
                </button>
              </div>
              <div style={{ fontSize: '.75rem', color: '#666', marginTop: '.5rem', fontFamily: 'monospace' }}>
                config: {JSON.stringify(s.config)}
              </div>
              {s.last_run_at && (
                <div style={{ fontSize: '.75rem', marginTop: '.5rem', color: s.last_run_status === 'ok' ? '#9ece6a' : '#f7768e' }}>
                  last run <Timestamp value={s.last_run_at} />: {s.last_run_status}
                  {s.last_run_summary && ` · last=${s.last_run_summary.signals_created ?? 0}, 7d=${s.last_run_summary.signals_7d ?? 0}, skipped=${s.last_run_summary.skipped ?? 0}`}
                  {s.last_run_summary?.errors && s.last_run_summary.errors.length > 0 && (
                    <div style={{ color: '#f7768e', marginTop: '.25rem' }}>errors: {s.last_run_summary.errors.join('; ')}</div>
                  )}
                </div>
              )}
              {lastRunResult?.source_id === s.id && (
                <pre style={{ marginTop: '.5rem', padding: '.5rem', background: '#111', fontSize: '.75rem', color: '#999', overflowX: 'auto' }}>
                  {JSON.stringify(lastRunResult.summary, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function renderField(
  f: { name: string; label: string; kind: string },
  value: unknown,
  onChange: (v: unknown) => void,
  entities: Entity[],
  inputStyle: React.CSSProperties,
) {
  if (f.kind === 'text') {
    return <input value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} style={inputStyle} />;
  }
  if (f.kind === 'textarea') {
    return <textarea value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} style={inputStyle} />;
  }
  if (f.kind === 'number') {
    return <input type="number" value={(value as number) ?? ''} onChange={(e) => onChange(parseFloat(e.target.value))} style={inputStyle} />;
  }
  if (f.kind === 'string_array') {
    const v = (value as string[]) ?? [];
    return (
      <input
        value={v.join(', ')}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        placeholder="comma, separated, values"
        style={inputStyle}
      />
    );
  }
  if (f.kind === 'entity_picker_multi') {
    const picked = (value as Array<{ entity_id: string; name: string; aliases?: string[] }>) ?? [];
    const pickedIds = new Set(picked.map((p) => p.entity_id));
    return (
      <div>
        <select
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            const ent = entities.find((x) => x.id === id);
            if (!ent || pickedIds.has(id)) return;
            onChange([...picked, { entity_id: id, name: ent.name, aliases: [] }]);
            e.target.value = '';
          }}
          style={inputStyle}
        >
          <option value="">+ add an account…</option>
          {entities.filter((e) => !pickedIds.has(e.id)).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        {picked.length > 0 && (
          <div style={{ marginTop: '.5rem', display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
            {picked.map((p, i) => (
              <div key={p.entity_id} style={{ padding: '.5rem', background: '#111', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '.85rem' }}>{p.name}</div>
                  <input
                    placeholder="aliases (optional, comma-separated)"
                    value={(p.aliases ?? []).join(', ')}
                    onChange={(e) => {
                      const next = [...picked];
                      next[i] = { ...p, aliases: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) };
                      onChange(next);
                    }}
                    style={{ ...inputStyle, marginTop: '.25rem', fontSize: '.75rem' }}
                  />
                </div>
                <button
                  onClick={() => onChange(picked.filter((_, j) => j !== i))}
                  style={{ marginLeft: '.5rem', padding: '.25rem .5rem', background: '#1f1f1f', color: '#e5e5e5', border: 'none', cursor: 'pointer', fontSize: '.75rem' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return <div style={{ color: '#f7768e', fontSize: '.75rem' }}>(unsupported field kind: {f.kind})</div>;
}
