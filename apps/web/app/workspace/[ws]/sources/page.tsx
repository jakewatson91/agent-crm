'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';
import { Timestamp } from '../../../_components/Timestamp';
import { useSetPageContext, type PageContext } from '../../../_components/PageContext';

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
  metrics: { signals: number; agent_fire_rate: number; fact_yield: number } | null;
  created_at: string;
}
interface Signal {
  id: string;
  type: string;
  body: string;
  magnitude: number | null;
  entity_id: string | null;
  entity_name: string | null;
  created_at: string;
  matched: boolean;
}
interface Entity { id: string; name: string; kind: string }

// ── Signal drawer (lazy-loads on open) ───────────────────────────────────────
function SignalDrawer({ sourceId, ws, signals7d }: { sourceId: string; ws: string; signals7d: number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useSWR<{ signals: Signal[] }>(
    open ? `/api/sources/${sourceId}/signals?workspace_id=${ws}` : null,
    DEFAULT_SWR,
  );

  const typeColor: Record<string, string> = {
    hiring_post: 'var(--accent-blue)',
    web_activity: 'var(--accent-purple)',
    hn_mention:   'var(--accent-amber)',
    rss_item:     'var(--accent-green)',
  };

  return (
    <div style={{ marginTop: '.75rem', borderTop: '1px solid var(--border)', paddingTop: '.6rem' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'var(--text-2)', fontSize: '.78rem', display: 'flex', alignItems: 'center', gap: '.3rem',
        }}
      >
        <span style={{ fontSize: '.65rem', opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
        {signals7d} signal{signals7d !== 1 ? 's' : ''} in last 7d
      </button>

      {open && (
        <div style={{ marginTop: '.6rem' }}>
          {isLoading && <div style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>loading…</div>}
          {!isLoading && (!data?.signals.length) && (
            <div style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>no signals yet</div>
          )}
          {!isLoading && data?.signals.map((sig) => (
            <div key={sig.id} style={{
              display: 'flex', gap: '.5rem', alignItems: 'flex-start',
              padding: '.35rem 0', borderBottom: '1px solid var(--border)', fontSize: '.78rem',
            }}>
              <span style={{
                flexShrink: 0, fontSize: '.68rem', padding: '.1rem .4rem', borderRadius: 4,
                background: 'var(--panel-2)', color: typeColor[sig.type] ?? 'var(--text-3)',
                fontFamily: 'var(--font-mono)',
              }}>
                {sig.type}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                  {sig.entity_name ?? <span style={{ color: 'var(--text-3)' }}>unlinked</span>}
                </span>
                {sig.body && (
                  <span style={{ color: 'var(--text-2)', marginLeft: '.4rem' }}>
                    · {sig.body.slice(0, 80)}{sig.body.length > 80 ? '…' : ''}
                  </span>
                )}
              </div>
              <span style={{ flexShrink: 0, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                <Timestamp value={sig.created_at} />
              </span>
              <span style={{ flexShrink: 0, fontSize: '.72rem', color: sig.matched ? 'var(--accent-green)' : 'var(--text-3)' }}>
                {sig.matched ? '✓' : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Config display ────────────────────────────────────────────────────────────
function ConfigDisplay({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(([, v]) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: '.5rem', display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
      {entries.map(([k, v]) => {
        let display: string;
        if (typeof v === 'string') display = v.length > 80 ? v.slice(0, 80) + '…' : v;
        else if (Array.isArray(v)) display = `[${(v as unknown[]).length} items]`;
        else display = String(v);
        return (
          <div key={k} style={{ fontSize: '.74rem', color: 'var(--text-2)', display: 'flex', gap: '.4rem' }}>
            <span style={{ color: 'var(--text-3)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>{k}</span>
            <span style={{ wordBreak: 'break-all' }}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Source card ───────────────────────────────────────────────────────────────
function SourceCard({
  s, ws, running, lastRunResult, onRunNow, origin,
}: {
  s: Source; ws: string; running: string | null;
  lastRunResult: { source_id: string; ok: boolean; summary: unknown } | null;
  onRunNow: (id: string) => void;
  origin: string;
}) {
  const [copied, setCopied] = useState(false);

  const statusColor = s.last_run_status === 'ok'
    ? 'var(--accent-green)'
    : s.last_run_status === 'error'
      ? 'var(--accent-coral)'
      : 'var(--text-3)';

  return (
    <div style={{
      padding: '.9rem 1rem', border: '1px solid var(--border)',
      borderRadius: 8, background: s.active ? 'var(--panel)' : 'var(--panel-2)',
      opacity: s.active ? 1 : 0.75,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '.75rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.95rem', fontWeight: 600, color: 'var(--text)' }}>{s.name}</span>
            <span style={{
              fontSize: '.68rem', padding: '.1rem .45rem', borderRadius: 4,
              background: 'var(--panel-2)', color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
            }}>
              {s.connector_type}
            </span>
            {!s.active && (
              <span style={{
                fontSize: '.68rem', padding: '.1rem .45rem', borderRadius: 4,
                background: 'var(--accent-amber-soft)', color: 'var(--accent-amber)',
              }}>
                paused
              </span>
            )}
          </div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: '.2rem' }}>
            {s.schedule_cron}
            {s.last_run_at && (
              <> · last run <Timestamp value={s.last_run_at} />
                <span style={{ color: statusColor }}>
                  {' '}· {s.last_run_status}
                </span>
                {s.last_run_summary && (
                  <span style={{ color: 'var(--text-3)' }}>
                    {' '}· {s.last_run_summary.signals_created ?? 0} new, {s.last_run_summary.signals_7d ?? 0} in 7d
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {s.connector_type === 'inbound_webhook' ? (
          <span style={{
            fontSize: '.72rem', padding: '.2rem .5rem', borderRadius: 4,
            border: '1px solid var(--accent-blue-soft)', color: 'var(--accent-blue)', flexShrink: 0,
          }}>
            push
          </span>
        ) : (
          <button
            onClick={() => onRunNow(s.id)}
            disabled={running === s.id}
            style={{
              padding: '.35rem .75rem', background: 'var(--accent-blue)', color: '#fff',
              border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: '.8rem', flexShrink: 0,
              opacity: running === s.id ? 0.5 : 1,
            }}
          >
            {running === s.id ? 'running…' : 'run now'}
          </button>
        )}
      </div>

      {/* Webhook URL */}
      {s.connector_type === 'inbound_webhook' && (() => {
        const url = `${origin}/api/ingest/webhook?source=${s.id}`;
        return (
          <div style={{
            marginTop: '.65rem', padding: '.6rem .75rem',
            background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6,
          }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: '.35rem' }}>
              Point Clay / Zapier / any tool at this URL. Bearer token = workspace API key.
            </div>
            <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
              <code style={{ flex: 1, fontSize: '.72rem', color: 'var(--accent-green)', wordBreak: 'break-all' }}>{url}</code>
              <button
                onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                style={{
                  padding: '.2rem .5rem', background: 'var(--panel)', color: 'var(--text-2)',
                  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: '.72rem', flexShrink: 0,
                }}
              >
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Config */}
      <ConfigDisplay config={s.config} />

      {/* Errors */}
      {s.last_run_summary?.errors && s.last_run_summary.errors.length > 0 && (
        <div style={{
          marginTop: '.6rem', padding: '.5rem .65rem', background: 'var(--accent-coral-soft)',
          border: '1px solid var(--accent-coral)', borderRadius: 5, fontSize: '.76rem', color: 'var(--accent-coral)',
        }}>
          {s.last_run_summary.errors.slice(0, 3).map((e, i) => <div key={i}>{e}</div>)}
          {s.last_run_summary.errors.length > 3 && (
            <div style={{ color: 'var(--text-3)', marginTop: '.2rem' }}>+{s.last_run_summary.errors.length - 3} more</div>
          )}
        </div>
      )}

      {/* Run-now result */}
      {lastRunResult?.source_id === s.id && (
        <pre style={{
          marginTop: '.5rem', padding: '.5rem .65rem', background: 'var(--panel-2)',
          border: '1px solid var(--border)', borderRadius: 5, fontSize: '.74rem',
          color: 'var(--text-2)', overflowX: 'auto',
        }}>
          {JSON.stringify(lastRunResult.summary, null, 2)}
        </pre>
      )}

      {/* Signals drawer */}
      <SignalDrawer
        sourceId={s.id}
        ws={ws}
        signals7d={s.last_run_summary?.signals_7d ?? s.metrics?.signals ?? 0}
      />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SourcesPage() {
  const params = useParams<{ ws: string }>();
  const connRes = useSWR<{ connectors: ConnectorMeta[] }>('/api/sources/connectors', { ...DEFAULT_SWR, revalidateOnFocus: false, revalidateIfStale: false });
  const sourcesRes = useSWR<{ sources: Source[] }>(`/api/sources/list?workspace_id=${params.ws}`, DEFAULT_SWR);
  const entitiesRes = useSWR<{ entities: Entity[] }>(`/api/entities/list?workspace_id=${params.ws}`, DEFAULT_SWR);
  const connectors = connRes.data?.connectors ?? [];
  const sources = sourcesRes.data?.sources ?? [];
  const entities = entitiesRes.data?.entities ?? [];

  async function refetchAfterMutation() {
    await Promise.all([sourcesRes.mutate(), entitiesRes.mutate()]);
  }

  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<ConnectorMeta | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRunResult, setLastRunResult] = useState<{ source_id: string; ok: boolean; summary: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nlDescription, setNlDescription] = useState('');
  const [parsing, setParsing] = useState(false);
  const [metaTokens, setMetaTokens] = useState<{ input: number; output: number } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const pageCtx = useMemo<PageContext>(() => {
    const active = sources.filter((s) => s.active).length;
    const paused = sources.length - active;
    const errored = sources.filter((s) => s.last_run_status === 'error').length;
    const bits = [`${active} active`];
    if (paused > 0) bits.push(`${paused} paused`);
    if (errored > 0) bits.push(`${errored} errored`);
    return {
      tab: 'sources',
      summary: bits.join(', '),
      visible: sources.slice(0, 10).map((s) => ({
        kind: 'source',
        id: s.id,
        label: `${s.name} (${s.connector_type}${!s.active ? ', paused' : ''}${s.last_run_status === 'error' ? ', errored' : ''})`,
      })),
    };
  }, [sources]);
  useSetPageContext(pageCtx);

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
        body: JSON.stringify({ workspace_id: params.ws, connector_type: picked.type, name: draftName, config: draftConfig }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'create failed'); return; }
      setPicked(null); setDraftName(''); setDraftConfig({}); setAddOpen(false);
      await refetchAfterMutation();
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
      await refetchAfterMutation();
    } finally {
      setRunning(null);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '.5rem', background: 'var(--panel)',
    color: 'var(--text)', border: '1px solid var(--border)',
    borderRadius: 5, fontFamily: 'inherit', fontSize: '.85rem',
  };
  const labelStyle: React.CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: '.25rem', display: 'block' };

  const active = sources.filter((s) => s.active);
  const errored = active.filter((s) => s.last_run_status === 'error');
  const silent = active.filter((s) => s.last_run_status === 'ok' && (s.last_run_summary?.signals_7d ?? 0) === 0);
  const producing = active.length - errored.length - silent.length;
  const paused = sources.length - active.length;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.75rem' }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: '.25rem' }}>Sources</h2>
          <p style={{ color: 'var(--text-2)', fontSize: '.88rem', margin: 0 }}>
            Ingest workers that run on a schedule and write signals.
          </p>
        </div>
        <button
          onClick={() => { setAddOpen((o) => !o); if (!addOpen) setPicked(null); }}
          style={{
            padding: '.4rem .85rem', background: addOpen ? 'var(--panel-2)' : 'var(--accent-blue)',
            color: addOpen ? 'var(--text)' : '#fff', border: addOpen ? '1px solid var(--border)' : 'none',
            borderRadius: 6, cursor: 'pointer', fontSize: '.85rem', flexShrink: 0,
          }}
        >
          {addOpen ? 'cancel' : '+ add source'}
        </button>
      </div>

      {/* Status chips */}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {[
          { label: `${producing} producing`, bg: 'var(--accent-green-soft)', color: 'var(--accent-green)', show: true },
          { label: `${silent.length} silent`, bg: 'var(--accent-amber-soft)', color: 'var(--accent-amber)', show: silent.length > 0 },
          { label: `${errored.length} errored`, bg: 'var(--accent-coral-soft)', color: 'var(--accent-coral)', show: errored.length > 0 },
          { label: `${paused} paused`, bg: 'var(--panel-2)', color: 'var(--text-3)', show: paused > 0 },
        ].filter((c) => c.show).map((c) => (
          <span key={c.label} style={{
            padding: '.2rem .55rem', borderRadius: 999, fontSize: '.74rem',
            background: c.bg, color: c.color,
          }}>
            {c.label}
          </span>
        ))}
      </div>

      {/* Add source accordion */}
      {addOpen && (
        <div style={{
          marginBottom: '1.5rem', padding: '1rem', border: '1px solid var(--border)',
          borderRadius: 8, background: 'var(--panel)',
        }}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>describe a source in plain English</label>
            <textarea
              value={nlDescription}
              onChange={(e) => setNlDescription(e.target.value)}
              rows={2}
              placeholder='e.g. "watch HN for posts about AI sales tools" or "the Lenny Substack feed"'
              style={inputStyle}
            />
            <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', alignItems: 'center' }}>
              <button
                onClick={nlParse}
                disabled={parsing || !nlDescription.trim()}
                style={{
                  padding: '.4rem .9rem', background: 'var(--accent-blue)', color: '#fff',
                  border: 'none', borderRadius: 5, cursor: 'pointer', opacity: parsing || !nlDescription.trim() ? 0.4 : 1, fontSize: '.85rem',
                }}
              >
                {parsing ? 'parsing…' : 'parse with agent'}
              </button>
              {metaTokens && <span style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{metaTokens.input}in / {metaTokens.output}out tokens</span>}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <label style={labelStyle}>or pick a connector directly</label>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: '.4rem' }}>Generic tools</div>
            <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.75rem' }}>
              {connectors.filter((c) => c.category === 'tool').map((c) => (
                <button key={c.type} onClick={() => pick(c)} title={c.description} style={{
                  padding: '.4rem .7rem', borderRadius: 5,
                  background: picked?.type === c.type ? 'var(--accent-blue)' : 'var(--panel-2)',
                  color: picked?.type === c.type ? '#fff' : 'var(--text)',
                  border: '1px solid var(--border)', cursor: 'pointer', fontSize: '.82rem',
                }}>{c.label}</button>
              ))}
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: '.4rem' }}>Presets</div>
            <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
              {connectors.filter((c) => c.category !== 'tool').map((c) => (
                <button key={c.type} onClick={() => pick(c)} title={c.description} style={{
                  padding: '.4rem .7rem', borderRadius: 5,
                  background: picked?.type === c.type ? 'var(--accent-blue)' : 'var(--panel-2)',
                  color: picked?.type === c.type ? '#fff' : 'var(--text)',
                  border: '1px solid var(--border)', cursor: 'pointer', fontSize: '.82rem',
                }}>{c.label}</button>
              ))}
            </div>
            {connectors.length === 0 && <span style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>no connectors registered</span>}
          </div>

          {picked && (
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
              <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>{picked.description}</div>
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: '.2rem' }}>schedule: {picked.schedule_cron}</div>

              <div style={{ marginTop: '.9rem' }}>
                <label style={labelStyle}>source name</label>
                <input value={draftName} onChange={(e) => setDraftName(e.target.value)} style={inputStyle} />
              </div>

              {picked.config_schema.fields.map((f) => (
                <div key={f.name} style={{ marginTop: '.75rem' }}>
                  <label style={labelStyle}>{f.label}{f.required ? ' *' : ''}</label>
                  {f.help && <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: '.25rem' }}>{f.help}</div>}
                  {renderField(f, draftConfig[f.name], (v) => setDraftConfig({ ...draftConfig, [f.name]: v }), entities, inputStyle)}
                </div>
              ))}

              {(() => {
                const knownFields = new Set(picked.config_schema.fields.map((f) => f.name));
                const extras = Object.keys(draftConfig).filter((k) => !knownFields.has(k));
                if (!extras.length) return null;
                return (
                  <div style={{ marginTop: '1rem', borderTop: '1px dashed var(--border)', paddingTop: '.75rem' }}>
                    <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: '.4rem' }}>extra fields from agent (editable):</div>
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
                          style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                        />
                      </div>
                    ))}
                  </div>
                );
              })()}

              {warnings.length > 0 && (
                <div style={{
                  marginTop: '.75rem', padding: '.5rem .65rem', borderRadius: 5,
                  background: 'var(--accent-amber-soft)', border: '1px solid var(--accent-amber)',
                  fontSize: '.8rem', color: 'var(--accent-amber)',
                }}>
                  {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}

              {error && <div style={{ marginTop: '.75rem', color: 'var(--accent-coral)', fontSize: '.85rem' }}>✗ {error}</div>}

              <div style={{ marginTop: '1rem', display: 'flex', gap: '.5rem' }}>
                <button
                  onClick={create}
                  disabled={creating || !draftName.trim()}
                  style={{
                    padding: '.45rem 1rem', background: 'var(--accent-green)', color: '#fff',
                    border: 'none', borderRadius: 5, cursor: 'pointer',
                    opacity: creating || !draftName.trim() ? 0.4 : 1,
                  }}
                >
                  {creating ? 'creating…' : 'create source'}
                </button>
                <button
                  onClick={() => { setPicked(null); setError(null); }}
                  style={{
                    padding: '.45rem .9rem', background: 'var(--panel-2)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer',
                  }}
                >
                  clear
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Source list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
        {sources.length === 0 && !sourcesRes.isLoading && (
          <div style={{ color: 'var(--text-3)', fontSize: '.88rem', padding: '1.5rem 0' }}>
            No sources configured. Add one above.
          </div>
        )}
        {sources.map((s) => (
          <SourceCard
            key={s.id}
            s={s}
            ws={params.ws}
            running={running}
            lastRunResult={lastRunResult}
            onRunNow={runNow}
            origin={origin}
          />
        ))}
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
              <div key={p.entity_id} style={{
                padding: '.5rem', background: 'var(--panel-2)', borderRadius: 5,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
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
                  style={{
                    marginLeft: '.5rem', padding: '.25rem .5rem', background: 'var(--panel)',
                    color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 4,
                    cursor: 'pointer', fontSize: '.75rem',
                  }}
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
  return <div style={{ color: 'var(--accent-coral)', fontSize: '.75rem' }}>(unsupported field kind: {f.kind})</div>;
}
