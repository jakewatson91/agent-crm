'use client';

/**
 * Floating chat widget for the global intake action (5.5b).
 *
 * SSE-streamed ReAct loop: the server emits each step (assistant text,
 * tool_call, tool_result) as a separate event. The widget renders each
 * one as it lands so the user sees the agent thinking step-by-step.
 *
 * Tool results render via type-specific renderers (lookup_entity → match
 * list, extract_facts → fact cards, propose_action → score bars) instead
 * of generic JSON blobs.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export function IntakeWidget() {
  const params = useParams<{ ws: string }>();
  const ws = params?.ws as string | undefined;
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape' && open) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, busy]);

  if (!ws) return null;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setErr(null); setBusy(true);
    setInput('');
    // History the server will see (without the new user turn we're about to send).
    const sentHistory = history;
    setHistory((prev) => [...prev, { role: 'user', content: text }]);

    try {
      const r = await fetch('/api/agent/intake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws, history: sentHistory, message: text }),
      });
      if (!r.ok || !r.body) { setErr(`request failed: ${r.status}`); return; }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE framing: events separated by \n\n; each "data: <json>\n" line.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.type === 'assistant' || payload.type === 'tool_result') {
              setHistory((prev) => [...prev, payload.message as ChatMessage]);
            } else if (payload.type === 'error') {
              setErr(payload.error ?? 'unknown error');
            }
          } catch { /* ignore malformed frame */ }
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function clear() { setHistory([]); setErr(null); }

  // --- styles ---
  const fab: React.CSSProperties = {
    position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
    width: 52, height: 52, borderRadius: 26,
    background: 'var(--accent)', color: 'var(--accent-fg)',
    border: 0, cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
    fontSize: '1.4rem', fontWeight: 600,
  };
  const panel: React.CSSProperties = {
    position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
    width: 440, maxWidth: 'calc(100vw - 40px)', height: 'min(680px, calc(100vh - 60px))',
    background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10,
    boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };
  const header: React.CSSProperties = {
    padding: '.6rem .9rem', borderBottom: '1px solid var(--border)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: '.85rem', fontWeight: 500,
  };
  const thread: React.CSSProperties = {
    flex: 1, overflowY: 'auto', padding: '.75rem', display: 'flex', flexDirection: 'column', gap: '.5rem',
  };
  const composer: React.CSSProperties = {
    padding: '.5rem', borderTop: '1px solid var(--border)', display: 'flex', gap: '.4rem',
  };
  const inputStyle: React.CSSProperties = {
    flex: 1, padding: '.5rem .6rem', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: '.85rem', resize: 'none', minHeight: 40, maxHeight: 120,
    fontFamily: 'inherit',
  };
  const sendBtn: React.CSSProperties = {
    padding: '.5rem .9rem', borderRadius: 6, border: 0,
    background: 'var(--accent)', color: 'var(--accent-fg)', cursor: 'pointer', fontWeight: 500,
  };

  return (
    <>
      {!open && (
        <button style={fab} onClick={() => setOpen(true)} title="Open intake (⌘K)" aria-label="Open intake">✦</button>
      )}
      {open && (
        <div style={panel} role="dialog" aria-label="Intake">
          <div style={header}>
            <div>
              <span style={{ marginRight: '.5rem' }}>✦</span>
              Intake
              <span style={{ marginLeft: '.5rem', color: 'var(--text-3)', fontSize: '.75rem' }}>⌘K to toggle</span>
            </div>
            <div style={{ display: 'flex', gap: '.4rem' }}>
              {history.length > 0 && (
                <button onClick={clear} style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', fontSize: '.75rem' }}>clear</button>
              )}
              <button onClick={() => setOpen(false)} style={{ background: 'transparent', border: 0, color: 'var(--text-2)', cursor: 'pointer', fontSize: '1rem' }}>×</button>
            </div>
          </div>

          <div ref={scrollRef} style={thread}>
            {history.length === 0 && (
              <div style={{ color: 'var(--text-3)', fontSize: '.85rem', lineHeight: 1.5 }}>
                Paste an observation about a company — a tweet, an article, something a founder said. The agent will find the entity, propose facts, score it, and tell you what to do.
                <div style={{ marginTop: '.6rem', padding: '.5rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: '.75rem' }}>
                  Sim CEO posted: shipping at $30M ARR with one salesperson. Founder-led outbound, no SDRs yet.
                </div>
              </div>
            )}
            {history.map((m, i) => <MessageView key={i} m={m} />)}
            {busy && <div style={{ color: 'var(--text-3)', fontSize: '.8rem', fontStyle: 'italic' }}>thinking…</div>}
            {err && <div style={{ color: '#c33', fontSize: '.8rem' }}>error: {err}</div>}
          </div>

          <div style={composer}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Paste an observation or ask…"
              style={inputStyle}
              disabled={busy}
            />
            <button onClick={send} disabled={busy || !input.trim()} style={sendBtn}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}

function MessageView({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '85%', padding: '.5rem .7rem', background: 'var(--accent)', color: 'var(--accent-fg)', borderRadius: 10, fontSize: '.85rem', whiteSpace: 'pre-wrap' }}>
        {m.content}
      </div>
    );
  }

  if (m.role === 'assistant') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        {m.content && (
          <div style={{ alignSelf: 'flex-start', maxWidth: '90%', padding: '.5rem .7rem', background: 'var(--panel-2)', color: 'var(--text)', borderRadius: 10, fontSize: '.85rem', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
            {m.content}
          </div>
        )}
        {m.tool_calls?.map((c) => (
          <div key={c.id} style={{ alignSelf: 'flex-start', maxWidth: '90%', fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace' }}>
            → {c.function.name}
          </div>
        ))}
      </div>
    );
  }

  if (m.role === 'tool') {
    return <ToolResultView name={m.name ?? '?'} content={m.content} />;
  }

  return null;
}

// ---------------------------------------------------------------
// Typed tool-result renderers
// ---------------------------------------------------------------

function ToolResultView({ name, content }: { name: string; content: string }) {
  let parsed: any = null;
  try { parsed = JSON.parse(content); } catch { /* fall through */ }
  if (!parsed) return <RawResult name={name} content={content} />;
  if (parsed.error) return <ErrorResult name={name} error={parsed.error} />;

  switch (name) {
    case 'lookup_entity':       return <LookupEntityResult data={parsed} />;
    case 'get_entity':          return <GetEntityResult data={parsed} />;
    case 'create_account':      return <CreateAccountResult data={parsed} />;
    case 'extract_facts':       return <ExtractFactsResult data={parsed} />;
    case 'assert_facts':        return <AssertFactsResult data={parsed} />;
    case 'rescore_entity':      return <RescoreResult data={parsed} />;
    case 'propose_action':      return <ProposeActionResult data={parsed} />;
    case 'trigger_drafter':     return <TriggerDrafterResult data={parsed} />;
    default:                    return <RawResult name={name} content={content} />;
  }
}

// Shared chrome around every result.
function ResultCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '.5rem .6rem', fontSize: '.78rem' }}>
      <div style={{ color: 'var(--text-3)', fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '.35rem', fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      {children}
    </div>
  );
}

function ErrorResult({ name, error }: { name: string; error: string }) {
  return (
    <ResultCard label={`${name} · error`}>
      <div style={{ color: '#c33', fontSize: '.75rem', wordBreak: 'break-word' }}>{error}</div>
    </ResultCard>
  );
}

function RawResult({ name, content }: { name: string; content: string }) {
  return (
    <details style={{ alignSelf: 'flex-start', maxWidth: '90%', fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer' }}>
      <summary>← {name} result</summary>
      <pre style={{ marginTop: '.3rem', padding: '.4rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {tryPretty(content)}
      </pre>
    </details>
  );
}

function LookupEntityResult({ data }: { data: any }) {
  const matches: Array<{ id: string; name: string; kind?: string; icp_fit?: number }> =
    Array.isArray(data?.matches) ? data.matches
    : Array.isArray(data) ? data
    : [];
  return (
    <ResultCard label={`lookup_entity · ${matches.length} match${matches.length === 1 ? '' : 'es'}`}>
      {matches.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>no match — agent may ask whether to create a new account.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          {matches.slice(0, 6).map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.78rem' }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-3)', fontSize: '.7rem' }}>{m.id.slice(0, 8)}</span>
              <span style={{ flex: 1 }}>{m.name}</span>
              {m.kind && <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{m.kind}</span>}
              {typeof m.icp_fit === 'number' && <ScoreChip value={m.icp_fit} />}
            </div>
          ))}
        </div>
      )}
    </ResultCard>
  );
}

function GetEntityResult({ data }: { data: any }) {
  const e = data?.entity ?? {};
  const facts: Array<{ predicate: string; object_text: string }> = data?.facts ?? [];
  return (
    <ResultCard label={`get_entity · ${e.name ?? '?'}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
        <div style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{e.kind} · {(e.id ?? '').slice(0, 8)}</div>
        <div style={{ marginTop: '.25rem' }}>
          {facts.slice(0, 8).map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem' }}>
              <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace' }}>{f.predicate}</span>
              <span style={{ flex: 1, wordBreak: 'break-word' }}>{f.object_text}</span>
            </div>
          ))}
          {facts.length > 8 && <div style={{ color: 'var(--text-3)', fontSize: '.7rem', marginTop: '.2rem' }}>… +{facts.length - 8} more</div>}
        </div>
      </div>
    </ResultCard>
  );
}

function CreateAccountResult({ data }: { data: any }) {
  return (
    <ResultCard label="create_account · created">
      <div>created <strong>{data.name}</strong> <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.7rem' }}>{(data.entity_id ?? '').slice(0, 8)}</span></div>
    </ResultCard>
  );
}

function ExtractFactsResult({ data }: { data: any }) {
  const facts: Array<{ predicate: string; object_text: string; confidence?: number }> = data?.facts ?? [];
  return (
    <ResultCard label={`extract_facts · ${facts.length} proposed`}>
      {facts.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>nothing new in this observation.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
          {facts.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.3rem .4rem', background: 'var(--panel)', borderRadius: 5, fontSize: '.78rem' }}>
              <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.7rem', minWidth: 90 }}>{f.predicate}</span>
              <span style={{ flex: 1, wordBreak: 'break-word' }}>{f.object_text}</span>
              {typeof f.confidence === 'number' && <span style={{ color: 'var(--text-3)', fontSize: '.65rem' }}>conf {f.confidence.toFixed(2)}</span>}
            </div>
          ))}
          <div style={{ color: 'var(--text-3)', fontSize: '.7rem', marginTop: '.2rem' }}>nothing written yet — confirm to assert.</div>
        </div>
      )}
    </ResultCard>
  );
}

function AssertFactsResult({ data }: { data: any }) {
  return (
    <ResultCard label="assert_facts · written">
      <div>asserted <strong>{data.asserted ?? 0}</strong> fact{data.asserted === 1 ? '' : 's'}{data.errors?.length ? ` · ${data.errors.length} error(s)` : ''}</div>
    </ResultCard>
  );
}

function RescoreResult({ data }: { data: any }) {
  return (
    <ResultCard label="rescore_entity">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <span>icp_total</span>
        <ScoreChip value={data.icp_total ?? 0} />
      </div>
      {data.breakdown && (
        <div style={{ marginTop: '.4rem', display: 'flex', flexDirection: 'column', gap: '.15rem' }}>
          {Object.entries(data.breakdown).filter(([k]) => k !== 'rrf_prefilter').map(([k, v]) => (
            <ScoreBar key={k} label={k} value={typeof v === 'number' ? v : 0} />
          ))}
        </div>
      )}
    </ResultCard>
  );
}

function ProposeActionResult({ data }: { data: any }) {
  const d = data?.decision ?? {};
  const breakdown = data?.breakdown ?? {};
  const actionColor: Record<string, string> = {
    draft_outreach: '#48a',
    watch_only: '#a92',
    deep_research: '#79a',
    drop: '#a48',
    continue: '#888',
  };
  return (
    <ResultCard label="propose_action">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.35rem' }}>
        <span style={{ padding: '.15rem .5rem', background: actionColor[d.action] ?? '#888', color: '#fff', borderRadius: 4, fontSize: '.72rem', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{d.action}</span>
        <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{d.policy}</span>
        {d.matched_theme && <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>· theme={d.matched_theme}</span>}
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-2)', marginBottom: '.4rem' }}>{d.reason}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>icp_total</span>
        <ScoreChip value={data.icp_total ?? 0} />
      </div>
      {breakdown && (
        <div style={{ marginTop: '.4rem', display: 'flex', flexDirection: 'column', gap: '.15rem' }}>
          {Object.entries(breakdown).filter(([k]) => k !== 'rrf_prefilter').map(([k, v]) => (
            <ScoreBar key={k} label={k} value={typeof v === 'number' ? v : 0} />
          ))}
        </div>
      )}
    </ResultCard>
  );
}

function TriggerDrafterResult({ data }: { data: any }) {
  return (
    <ResultCard label="trigger_drafter · fired">
      <div>drafter agent.run dispatched.</div>
      <div style={{ color: 'var(--text-3)', fontSize: '.7rem', marginTop: '.2rem' }}>draft will land in Inbox once the agent finishes. signal={(data.signal_id ?? '').slice(0, 8)}</div>
    </ResultCard>
  );
}

function ScoreChip({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  const color = v >= 0.65 ? '#48a' : v >= 0.5 ? '#79a' : v >= 0.35 ? '#a92' : '#a48';
  return (
    <span style={{ padding: '.1rem .35rem', background: color, color: '#fff', borderRadius: 3, fontSize: '.7rem', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
      {v.toFixed(2)}
    </span>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.7rem' }}>
      <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', minWidth: 110 }}>{label}</span>
      <div style={{ flex: 1, background: 'var(--panel)', borderRadius: 2, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${v * 100}%`, height: '100%', background: 'var(--accent)' }} />
      </div>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-2)', minWidth: 36, textAlign: 'right' }}>{v.toFixed(2)}</span>
    </div>
  );
}

function tryPretty(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
