'use client';

/**
 * Floating chat widget for the global intake action (5.5b).
 *
 * Bottom-right button → expands a side panel with a chat thread.
 * Each message is rendered inline with role-aware styling. Tool calls + tool
 * results render as collapsible cards so the user sees the ReAct trace
 * without it dominating the view.
 *
 * Stateless from the server's perspective — full conversation history is
 * sent with every message. Trims to last 20 turns server-side.
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

  // Keyboard: ⌘K / Ctrl+K toggles the widget from anywhere.
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

  if (!ws) return null; // only show inside a workspace

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setErr(null); setBusy(true);
    setInput('');
    // Optimistic user echo
    setHistory((prev) => [...prev, { role: 'user', content: text }]);
    try {
      const r = await fetch('/api/agent/intake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws, history, message: text }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error ?? 'request failed'); return; }
      // Server returns the trace including the user echo. Replace the optimistic
      // turn with the canonical trace so tool calls + results appear inline.
      setHistory((prev) => {
        // Drop the optimistic last user message and append the canonical trace.
        const base = prev.slice(0, -1);
        return [...base, ...(j.trace as ChatMessage[])];
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setHistory([]);
    setErr(null);
  }

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
    width: 420, maxWidth: 'calc(100vw - 40px)', height: 'min(640px, calc(100vh - 60px))',
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
        <button style={fab} onClick={() => setOpen(true)} title="Open intake (⌘K)" aria-label="Open intake">
          ✦
        </button>
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
            → {c.function.name}({truncate(c.function.arguments, 80)})
          </div>
        ))}
      </div>
    );
  }

  if (m.role === 'tool') {
    return (
      <details style={{ alignSelf: 'flex-start', maxWidth: '90%', fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer' }}>
        <summary>← {m.name} result</summary>
        <pre style={{ marginTop: '.3rem', padding: '.4rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {tryPrettyJson(m.content)}
        </pre>
      </details>
    );
  }

  return null;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function tryPrettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
