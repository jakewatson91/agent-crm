'use client';

/**
 * Full-surface chat for the agent (AI SDK v6).
 *
 * useChat() owns the streaming + thread state. The server (route.ts) runs
 * streamText with our 8 intake tools. UIMessage parts come back as text /
 * reasoning / tool-<name> entries; we render each through the existing
 * typed result cards so the chat surface is dense, not raw JSON.
 *
 * Conversation persistence: the server-generated conversation_id arrives on
 * the first stream as a transient data part. Subsequent requests echo it in
 * the transport body so the server keeps writing to the same row.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TextareaAutosize from 'react-textarea-autosize';
import { lowConfLabel } from '../_lib/confidence';
import { bandColor } from '../_lib/bands';
import { usePageContextGetter } from './PageContext';
import { CiteChain } from './CiteChain';

interface ThreadSummary {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

export function Chat({ ws, initialMessage, onClose }: { ws: string; initialMessage?: string; onClose?: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;

  const [input, setInput] = useState('');

  // Thread picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  const getPageContext = usePageContextGetter();

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: '/api/agent/intake',
      // Resolver so the most-recent conversation_id + the current page's
      // visible-state snapshot ride every request.
      body: () => ({
        workspace_id: ws,
        conversation_id: conversationIdRef.current ?? undefined,
        page_context: getPageContext() ?? undefined,
      }),
    }),
    [ws, getPageContext],
  );

  const {
    messages,
    sendMessage,
    setMessages,
    stop,
    status,
    error,
    clearError,
    regenerate,
  } = useChat({
    transport,
    onData: (part) => {
      // Server emits { type: 'data-thread', data: { conversation_id } } on
      // the first turn of a fresh thread. Capture it so subsequent turns
      // hit the same DB row.
      if (part.type === 'data-thread') {
        const id = (part.data as { conversation_id?: string } | undefined)?.conversation_id;
        if (id) setConversationId(id);
      }
    },
    onError: (e) => {
      console.error('[chat]', e);
    },
  });

  // Autoscroll on new content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, status]);

  // Seed an initial message if a caller passed one (entry points that paste
  // an observation directly).
  useEffect(() => {
    if (seededRef.current) return;
    if (!initialMessage || !initialMessage.trim()) return;
    seededRef.current = true;
    void sendMessage({ text: initialMessage.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  const busy = status === 'submitted' || status === 'streaming';

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    if (error) clearError();
    void sendMessage({ text });
  }

  function newChat() {
    setMessages([]);
    setConversationId(null);
    if (error) clearError();
    setPickerOpen(false);
  }

  async function openPicker() {
    if (pickerOpen) { setPickerOpen(false); return; }
    setPickerOpen(true);
    setThreadsLoading(true);
    try {
      const r = await fetch(`/api/agent/intake/threads?workspace_id=${encodeURIComponent(ws)}&limit=30`);
      if (!r.ok) return;
      const body = await r.json() as { threads: ThreadSummary[] };
      setThreads(body.threads ?? []);
    } catch { /* ignore */ }
    finally { setThreadsLoading(false); }
  }

  async function loadThread(id: string) {
    setPickerOpen(false);
    if (error) clearError();
    try {
      const r = await fetch(`/api/agent/intake/thread?id=${encodeURIComponent(id)}&workspace_id=${encodeURIComponent(ws)}`);
      if (!r.ok) return;
      const body = await r.json() as { conversation_id: string; messages: unknown[] };
      setConversationId(body.conversation_id);
      // Legacy threads (old ChatMessage shape with `content`, no `parts`) won't
      // hydrate cleanly; filter to entries that look like UIMessages so the
      // surface doesn't break.
      const hydrated: UIMessage[] = (body.messages ?? [])
        .filter((m): m is UIMessage => {
          if (!m || typeof m !== 'object') return false;
          const r = m as Record<string, unknown>;
          return typeof r.id === 'string' && Array.isArray(r.parts);
        });
      setMessages(hydrated);
    } catch { /* ignore */ }
  }

  async function deleteThread(id: string) {
    try {
      const r = await fetch(`/api/agent/intake/thread?id=${encodeURIComponent(id)}&workspace_id=${encodeURIComponent(ws)}`, {
        method: 'DELETE',
      });
      if (!r.ok) return;
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (conversationId === id) newChat();
    } catch { /* ignore */ }
  }

  const shell: React.CSSProperties = {
    display: 'flex', flexDirection: 'column',
    height: '100%', minHeight: 0,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
  };
  const header: React.CSSProperties = {
    padding: '.75rem 1rem', borderBottom: '1px solid var(--border)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: '.85rem', fontWeight: 500,
    position: 'relative',
  };
  const thread: React.CSSProperties = {
    flex: 1, overflowY: 'auto', padding: '1rem 1.25rem',
    display: 'flex', flexDirection: 'column', gap: '.6rem',
  };
  const composer: React.CSSProperties = {
    padding: '.6rem', borderTop: '1px solid var(--border)',
    display: 'flex', gap: '.5rem', alignItems: 'flex-end',
  };
  const sendBtn: React.CSSProperties = {
    padding: '.6rem 1.1rem', borderRadius: 6, border: 0,
    background: 'var(--accent)', color: 'var(--accent-fg)', cursor: 'pointer', fontWeight: 500,
  };
  const stopBtn: React.CSSProperties = {
    padding: '.6rem 1.1rem', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--panel-2)', color: 'var(--text)', cursor: 'pointer', fontWeight: 500,
  };
  const headerBtn: React.CSSProperties = {
    background: 'transparent', border: 0, color: 'var(--text-3)',
    cursor: 'pointer', fontSize: '.75rem',
  };

  return (
    <div style={shell} role="region" aria-label="Agent chat">
      <div style={header}>
        <div>
          <span style={{ color: 'var(--accent)', marginRight: '.5rem' }}>✦</span>
          Agent
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
          <button onClick={openPicker} style={headerBtn} title="Browse prior threads">
            Recent {pickerOpen ? '▴' : '▾'}
          </button>
          <button onClick={newChat} style={headerBtn} title="Start a fresh thread">
            + New
          </button>
          {onClose && (
            <button onClick={onClose} aria-label="Close chat" title="Close (⌘J)" style={{ background: 'transparent', border: 0, color: 'var(--text-2)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 .25rem' }}>×</button>
          )}
        </div>

        {pickerOpen && (
          <ThreadPicker
            threads={threads}
            loading={threadsLoading}
            activeId={conversationId}
            onLoad={loadThread}
            onDelete={deleteThread}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      <div ref={scrollRef} style={thread}>
        {messages.map((m, i) => (
          <MessageView
            key={m.id}
            m={m}
            ws={ws}
            isLast={i === messages.length - 1}
            streaming={busy && i === messages.length - 1}
          />
        ))}
        {status === 'submitted' && messages[messages.length - 1]?.role === 'user' && (
          <div style={{ color: 'var(--text-3)', fontSize: '.8rem', fontStyle: 'italic' }}>thinking…</div>
        )}
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', color: '#c33', fontSize: '.8rem' }}>
            <span>error: {error.message}</span>
            <button onClick={() => regenerate()} style={{ ...headerBtn, color: '#c33', textDecoration: 'underline' }}>retry</button>
          </div>
        )}
      </div>

      <div style={composer}>
        <TextareaAutosize
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Paste an observation or ask…"
          minRows={1}
          maxRows={8}
          disabled={busy}
          autoFocus
          style={{
            flex: 1, padding: '.6rem .75rem', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text)', fontSize: '.9rem', resize: 'none',
            fontFamily: 'inherit', lineHeight: 1.4,
          }}
        />
        {busy ? (
          <button onClick={() => stop()} style={stopBtn} title="Stop generating">Stop</button>
        ) : (
          <button onClick={submit} disabled={!input.trim()} style={sendBtn}>Send</button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Message rendering — walks UIMessage.parts and dispatches by part type.
// ---------------------------------------------------------------

function MessageView({ m, ws, streaming }: { m: UIMessage; ws: string; isLast: boolean; streaming: boolean }) {
  if (m.role === 'user') {
    const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
    if (!text) return null;
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '75%', padding: '.55rem .8rem', background: 'var(--accent)', color: 'var(--accent-fg)', borderRadius: 10, fontSize: '.88rem', whiteSpace: 'pre-wrap' }}>
        {text}
      </div>
    );
  }

  if (m.role !== 'assistant') return null;

  // Find the active reasoning part (streaming or last reasoning if no text yet).
  // We only show the thinking pill while it's actively producing; once text
  // arrives we drop it.
  const reasoningParts = m.parts.filter((p) => p.type === 'reasoning') as Array<{ type: 'reasoning'; text: string; state?: string }>;
  const hasText = m.parts.some((p) => p.type === 'text' && (p as { text: string }).text.length > 0);
  const activeReasoning = streaming && !hasText && reasoningParts.length > 0
    ? reasoningParts[reasoningParts.length - 1]
    : null;

  return (
    <>
      {activeReasoning && <ThinkingPill text={activeReasoning.text} />}
      {m.parts.map((part, i) => {
        if (part.type === 'text') {
          const text = (part as { text: string }).text;
          if (!text) return null;
          return <AssistantText key={i} text={text} />;
        }
        if (part.type === 'reasoning') {
          // Collapsed reasoning is already shown live via the pill above —
          // once the message has text, drop the pill and don't show reasoning
          // again. (We could surface it under a <details> later if useful.)
          return null;
        }
        if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
          return <ToolPartView key={i} part={part as ToolUIPartLike} ws={ws} />;
        }
        return null;
      })}
    </>
  );
}

function AssistantText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked */ }
  };
  return (
    <div className="assistant-bubble" style={{
      alignSelf: 'flex-start', maxWidth: '85%',
      padding: '.55rem .8rem',
      background: 'var(--panel-2)', color: 'var(--text)',
      borderRadius: 10, fontSize: '.88rem', lineHeight: 1.5,
      position: 'relative',
    }}>
      <button
        onClick={onCopy}
        title={copied ? 'Copied' : 'Copy'}
        className="copy-btn"
        style={{
          position: 'absolute', top: 4, right: 4,
          background: 'var(--panel)', border: '1px solid var(--border)',
          color: 'var(--text-3)', cursor: 'pointer',
          fontSize: '.65rem', padding: '.15rem .35rem', borderRadius: 4,
          opacity: 0, transition: 'opacity 120ms ease',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {copied ? '✓' : 'copy'}
      </button>
      <style>{`
        .assistant-bubble:hover .copy-btn { opacity: 1; }
      `}</style>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
      <style>{`
        .md p { margin: 0 0 .5em; }
        .md p:last-child { margin-bottom: 0; }
        .md ul, .md ol { margin: .25em 0 .5em; padding-left: 1.25em; }
        .md li { margin: .1em 0; }
        .md code {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          font-size: .85em;
          background: var(--panel); padding: .05em .35em;
          border-radius: 3px;
        }
        .md pre {
          background: var(--panel); padding: .5em .65em;
          border-radius: 5px; overflow-x: auto;
          margin: .35em 0;
        }
        .md pre code { background: transparent; padding: 0; }
        .md h1, .md h2, .md h3 { font-size: 1em; font-weight: 600; margin: .35em 0 .2em; }
        .md a { color: var(--accent); text-decoration: underline; }
        .md blockquote {
          margin: .25em 0; padding-left: .75em;
          border-left: 2px solid var(--border); color: var(--text-2);
        }
        .md table { border-collapse: collapse; font-size: .82em; margin: .35em 0; }
        .md th, .md td { padding: .2em .5em; border: 1px solid var(--border); }
        .md th { background: var(--panel); font-weight: 600; }
      `}</style>
    </div>
  );
}

function ThinkingPill({ text }: { text: string }) {
  // Show the trailing slice so the eye lands on fresh tokens. Plain truncation
  // (no rtl/bdo hack).
  const tail = text.length > 140 ? '…' + text.slice(-140) : text;
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '85%', padding: '.4rem .65rem', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 8, fontSize: '.72rem', color: 'var(--text-3)', fontStyle: 'italic', display: 'flex', gap: '.5rem', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.05em', fontStyle: 'normal' }}>thinking</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
        {tail}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------
// Tool parts — map the AI SDK ToolUIPart shape onto the existing typed
// renderer dispatch. Each tool emits its own part type `tool-<name>`.
// ---------------------------------------------------------------

// Loose shape of a tool UIPart. AI SDK's exact type is generic on the toolset;
// we only need a few fields here.
type ToolUIPartLike = {
  type: string;                     // `tool-${name}`
  state?: string;                   // input-streaming | input-available | output-available | output-error
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function ToolPartView({ part, ws }: { part: ToolUIPartLike; ws: string }) {
  const name = part.type.startsWith('tool-') ? part.type.slice(5) : part.type;

  // Input still streaming or input-only (no result yet) — show a compact
  // "running …" chip so the user sees that something is happening.
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: '85%', padding: '.4rem .65rem', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 8, fontSize: '.72rem', color: 'var(--text-3)', fontStyle: 'italic', display: 'flex', gap: '.5rem', alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.05em', fontStyle: 'normal' }}>running</span>
        <span>{name}…</span>
      </div>
    );
  }

  if (part.state === 'output-error') {
    return <ErrorResult name={name} error={part.errorText ?? 'tool error'} />;
  }

  // output-available
  const output = part.output;
  // Tool executors may stringify large results to stay under the token cap.
  let parsed: unknown = output;
  if (typeof output === 'string') {
    try { parsed = JSON.parse(output); } catch { /* keep string */ }
  }

  if (parsed && typeof parsed === 'object' && (parsed as { error?: unknown }).error) {
    return <ErrorResult name={name} error={String((parsed as { error: unknown }).error)} />;
  }

  switch (name) {
    case 'query':            return <QueryResult data={parsed} ws={ws} />;
    case 'create_account':   return <CreateAccountResult data={parsed} />;
    case 'enrich_contacts':  return <EnrichContactsResult data={parsed} />;
    case 'extract_facts':    return <ExtractFactsResult data={parsed} />;
    case 'assert_facts':     return <AssertFactsResult data={parsed} />;
    case 'rescore_entity':   return <RescoreResult data={parsed} />;
    case 'propose_action':   return <ProposeActionResult data={parsed} />;
    case 'trigger_drafter':  return <TriggerDrafterResult data={parsed} />;
    default:                 return <RawResult name={name} content={typeof output === 'string' ? output : JSON.stringify(output)} />;
  }
}

// ---------------------------------------------------------------
// Thread picker — unchanged.
// ---------------------------------------------------------------

function ThreadPicker({
  threads, loading, activeId, onLoad, onDelete, onClose,
}: {
  threads: ThreadSummary[]; loading: boolean; activeId: string | null;
  onLoad: (id: string) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 9 }}
      />
      <div style={{
        position: 'absolute', top: '100%', right: '1rem', zIndex: 10,
        marginTop: 4, width: 360, maxHeight: 400, overflowY: 'auto',
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '.4rem',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      }}>
        {loading && (
          <div style={{ padding: '.6rem', color: 'var(--text-3)', fontSize: '.8rem', fontStyle: 'italic' }}>
            loading…
          </div>
        )}
        {!loading && threads.length === 0 && (
          <div style={{ padding: '.6rem', color: 'var(--text-3)', fontSize: '.8rem' }}>
            No prior threads.
          </div>
        )}
        {!loading && threads.map((t) => (
          <div
            key={t.id}
            style={{
              display: 'flex', alignItems: 'center', gap: '.4rem',
              padding: '.45rem .55rem', borderRadius: 5,
              background: t.id === activeId ? 'var(--panel-2)' : 'transparent',
              cursor: 'pointer', fontSize: '.8rem',
            }}
            onClick={() => onLoad(t.id)}
            onMouseEnter={(e) => { if (t.id !== activeId) e.currentTarget.style.background = 'var(--panel-2)'; }}
            onMouseLeave={(e) => { if (t.id !== activeId) e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                {t.title}
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>
                {t.message_count} msg · {relTime(t.updated_at)}
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); if (confirm('Delete this thread?')) onDelete(t.id); }}
              title="Delete thread"
              style={{
                background: 'transparent', border: 0, color: 'var(--text-3)',
                cursor: 'pointer', fontSize: '.9rem', padding: '0 .25rem',
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------
// Tool result cards (unchanged from prior implementation — they take parsed
// JSON; the dispatcher now passes part.output instead of JSON.parse(content)).
// ---------------------------------------------------------------

function ResultCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '85%', width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '.55rem .7rem', fontSize: '.8rem' }}>
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
    <details style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: '.72rem', color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer' }}>
      <summary>← {name} result</summary>
      <pre style={{ marginTop: '.3rem', padding: '.4rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {tryPretty(content)}
      </pre>
    </details>
  );
}

function QueryResult({ data, ws }: { data: any; ws: string }) {
  const scope: string = data?.scope ?? '?';
  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];

  if (rows.length === 0) {
    return (
      <ResultCard label={`query · ${scope} · 0`}>
        <div style={{ color: 'var(--text-3)' }}>{data?.note ?? 'no rows.'}</div>
      </ResultCard>
    );
  }

  switch (scope) {
    case 'entities':  return <QueryEntities rows={rows} total={data?.total_scored} />;
    case 'facts':     return <QueryFacts rows={rows} />;
    case 'events':    return <QueryEvents rows={rows} ws={ws} />;
    case 'sources':   return <QuerySources rows={rows} window={data?.window_hours} />;
    case 'gates':     return <QueryGates rows={rows} />;
    case 'contacts':  return <QueryContacts data={data} />;
    default:          return <RawResult name={`query/${scope}`} content={JSON.stringify(data)} />;
  }
}

function QueryContacts({ data }: { data: any }) {
  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const acct = data?.account;
  const linked = data?.linked_count ?? 0;
  const domainOnly = data?.domain_only_count ?? 0;
  const label = `query · contacts · ${acct?.name ?? '?'} · ${linked} linked${domainOnly ? ` + ${domainOnly} domain-only` : ''}`;
  return (
    <ResultCard label={label}>
      {acct?.domain && (
        <div style={{ color: 'var(--text-3)', fontSize: '.7rem', marginBottom: '.3rem', fontFamily: 'JetBrains Mono, monospace' }}>@{acct.domain}</div>
      )}
      {rows.length === 0 && <div style={{ color: 'var(--text-3)' }}>{data?.note ?? 'no contacts.'}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
        {rows.map((r, i) => (
          <div key={r.entity_id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem', alignItems: 'baseline' }}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.65rem' }}>{(r.entity_id ?? '').slice(0, 8)}</span>
            <span style={{ minWidth: 120 }}>{r.name}</span>
            {r.email && <span style={{ color: 'var(--text-2)', fontSize: '.7rem' }}>{r.email}</span>}
            {r.role && <span style={{ color: 'var(--text-3)', fontSize: '.7rem', fontStyle: 'italic' }}>{r.role}</span>}
            <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: '.65rem', fontFamily: 'JetBrains Mono, monospace' }}>{r.link_source}</span>
          </div>
        ))}
      </div>
    </ResultCard>
  );
}

function EnrichContactsResult({ data }: { data: any }) {
  const rows: any[] = Array.isArray(data?.contacts) ? data.contacts : [];
  return (
    <ResultCard label={`enrich_contacts · ${data?.domain ?? '?'} · ${data?.created ?? 0} new + ${data?.existed ?? 0} existed`}>
      {rows.length === 0 && <div style={{ color: 'var(--text-3)' }}>no contacts returned.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
        {rows.map((r, i) => (
          <div key={r.contact_entity_id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem', alignItems: 'baseline' }}>
            <span style={{ color: r.created ? '#3a7' : 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.65rem', minWidth: 50 }}>{r.created ? 'new' : 'existed'}</span>
            <span style={{ minWidth: 120 }}>{r.name}</span>
            <span style={{ color: 'var(--text-2)', fontSize: '.7rem' }}>{r.email}</span>
            {r.role && <span style={{ color: 'var(--text-3)', fontSize: '.7rem', fontStyle: 'italic' }}>{r.role}</span>}
          </div>
        ))}
      </div>
    </ResultCard>
  );
}

function QueryEntities({ rows, total }: { rows: any[]; total?: number }) {
  const single = rows.length === 1 && rows[0]?.facts !== undefined;
  if (single) {
    const e = rows[0];
    const facts: Array<{ id: string; predicate: string; object_text: string }> = e.facts ?? [];
    return (
      <ResultCard label={`query · entities · ${e.name ?? '?'}`}>
        <div style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{e.kind} · {(e.id ?? '').slice(0, 8)}</div>
        <div style={{ marginTop: '.25rem' }}>
          {facts.slice(0, 8).map((f, i) => (
            <div key={f.id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace' }}>{f.predicate}</span>
              <span style={{ flex: 1, wordBreak: 'break-word' }}>{f.object_text}</span>
              {f.id && <CiteChain fact_id={f.id} label="trace" />}
            </div>
          ))}
          {facts.length > 8 && <div style={{ color: 'var(--text-3)', fontSize: '.7rem', marginTop: '.2rem' }}>… +{facts.length - 8} more</div>}
        </div>
      </ResultCard>
    );
  }

  const isMatch = rows[0]?.entity_id !== undefined && rows[0]?.score !== undefined;
  return (
    <ResultCard label={`query · entities · ${rows.length}${total != null ? ` of ${total} scored` : ''}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
        {rows.map((r, i) => (
          <div key={r.entity_id ?? i} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.78rem' }}>
            {!isMatch && <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.7rem', minWidth: 18 }}>{i + 1}.</span>}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-3)', fontSize: '.7rem' }}>{(r.entity_id ?? '').slice(0, 8)}</span>
            <span style={{ flex: 1 }}>{r.name}</span>
            {r.kind && <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{r.kind}</span>}
            {typeof r.icp_fit === 'number' && <ScoreChip value={r.icp_fit} />}
          </div>
        ))}
      </div>
    </ResultCard>
  );
}

function QueryFacts({ rows }: { rows: any[] }) {
  return (
    <ResultCard label={`query · facts · ${rows.length}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
        {rows.slice(0, 20).map((f, i) => (
          <div key={f.id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', minWidth: 110 }}>{f.predicate}</span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{f.object_text}</span>
            {lowConfLabel(f.confidence) && <span style={{ color: 'var(--accent-coral)', fontSize: '.65rem' }}>{lowConfLabel(f.confidence)}</span>}
            {f.id && <CiteChain fact_id={f.id} label="trace" />}
          </div>
        ))}
        {rows.length > 20 && <div style={{ color: 'var(--text-3)', fontSize: '.7rem', marginTop: '.2rem' }}>… +{rows.length - 20} more</div>}
      </div>
    </ResultCard>
  );
}

function QueryEvents({ rows, ws }: { rows: any[]; ws: string }) {
  const isAgentActions = rows[0]?.action_type !== undefined && rows[0]?.event_id !== undefined;
  if (isAgentActions) return <AgentActionsCard rows={rows} ws={ws} />;
  return (
    <ResultCard label={`query · events · ${rows.length}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
        {rows.slice(0, 20).map((e, i) => (
          <div key={e.id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem' }}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', minWidth: 120 }}>{e.action}</span>
            <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{relTime(e.created_at)}</span>
            <span style={{ flex: 1, color: 'var(--text-2)', wordBreak: 'break-word' }}>{e.target_kind}{e.target_id ? `:${String(e.target_id).slice(0, 8)}` : ''}</span>
          </div>
        ))}
      </div>
    </ResultCard>
  );
}

function QuerySources({ rows, window }: { rows: any[]; window?: number }) {
  return (
    <ResultCard label={`query · sources · ${rows.length}${window ? ` · ${window}h window` : ''}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
        {rows.slice(0, 20).map((s, i) => (
          <div key={s.id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem', alignItems: 'center' }}>
            <span style={{ flex: 1, fontWeight: 500 }}>{s.name ?? s.id}</span>
            <span style={{ color: 'var(--text-3)', fontSize: '.7rem', fontFamily: 'JetBrains Mono, monospace' }}>
              sig {s.signals ?? 0} · runs {s.agent_runs ?? 0} · facts {s.facts ?? 0}
            </span>
          </div>
        ))}
      </div>
    </ResultCard>
  );
}

function QueryGates({ rows }: { rows: any[] }) {
  return (
    <ResultCard label={`query · gates · ${rows.length}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
        {rows.slice(0, 20).map((g, i) => (
          <div key={g.id ?? i} style={{ display: 'flex', gap: '.5rem', fontSize: '.75rem', alignItems: 'center' }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-3)', fontSize: '.7rem' }}>{(g.id ?? '').slice(0, 8)}</span>
            <span style={{ flex: 1 }}>{g.kind} · {g.policy ?? ''}</span>
            <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>
              {g.decided_at ? `${g.decision} ${relTime(g.decided_at)}` : 'pending'}
            </span>
          </div>
        ))}
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
              {lowConfLabel(f.confidence) && <span style={{ color: 'var(--accent-coral)', fontSize: '.65rem' }}>{lowConfLabel(f.confidence)}</span>}
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
        <span>score</span>
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
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-2)', marginBottom: '.4rem' }}>{d.reason}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>score</span>
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
  const color = bandColor(v);
  return (
    <span style={{ padding: '.1rem .35rem', background: color, color: '#fff', borderRadius: 3, fontSize: '.7rem', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
      {v.toFixed(2)}
    </span>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(1, value));
  const color = bandColor(v);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.7rem' }}>
      <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', minWidth: 110 }}>{label}</span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', color, fontWeight: 600 }}>{v.toFixed(2)}</span>
    </div>
  );
}

function tryPretty(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// ---------------------------------------------------------------
// Agent actions card with inline undo (used when query scope=events,
// filter.action=agent_action_taken).
// ---------------------------------------------------------------

interface AgentActionRow {
  event_id: string;
  taken_at: string;
  action_type: string;
  source_name: string;
  reasoning: string;
  new_query?: string | null;
  new_subscription_semantic?: string | null;
  undone: boolean;
}

function AgentActionsCard({ rows: initial, ws }: { rows: AgentActionRow[]; ws: string }) {
  const [rows, setRows] = useState<AgentActionRow[]>(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const undo = async (event_id: string) => {
    setPendingId(event_id);
    setErrorMsg(null);
    try {
      const r = await fetch('/api/agent_actions/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id, workspace_id: ws }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `undo failed (${r.status})`);
      setRows((prev) => prev.map((row) => row.event_id === event_id ? { ...row, undone: true } : row));
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <ResultCard label={`query · events · agent_action_taken · ${rows.length}`}>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>the agent has not made any reversible changes recently.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          {rows.map((row) => (
            <div key={row.event_id} style={{ padding: '.45rem .55rem', background: 'var(--panel)', borderRadius: 5, display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.75rem' }}>
                <span style={{ color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: '.7rem' }}>
                  {actionLabel(row.action_type)}
                </span>
                <span style={{ flex: 1, fontWeight: 500 }}>{row.source_name}</span>
                <span style={{ color: 'var(--text-3)', fontSize: '.65rem' }}>{relTime(row.taken_at)}</span>
                {row.undone ? (
                  <span style={{ color: 'var(--text-3)', fontSize: '.7rem', fontStyle: 'italic' }}>undone</span>
                ) : (
                  <button
                    onClick={() => undo(row.event_id)}
                    disabled={pendingId === row.event_id}
                    style={{
                      padding: '.15rem .5rem', fontSize: '.7rem', borderRadius: 4,
                      border: '1px solid var(--border)', background: 'var(--panel-2)',
                      color: 'var(--text-2)', cursor: pendingId === row.event_id ? 'default' : 'pointer',
                      opacity: pendingId === row.event_id ? 0.5 : 1,
                    }}
                  >
                    {pendingId === row.event_id ? '…' : 'Undo'}
                  </button>
                )}
              </div>
              {row.reasoning && (
                <div style={{ color: 'var(--text-2)', fontSize: '.72rem', wordBreak: 'break-word' }}>{row.reasoning}</div>
              )}
              {row.new_query && (
                <div style={{ color: 'var(--text-3)', fontSize: '.7rem', fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-word' }}>
                  new query: {row.new_query}
                </div>
              )}
              {row.new_subscription_semantic && (
                <div style={{ color: 'var(--text-3)', fontSize: '.7rem', wordBreak: 'break-word' }}>
                  new subscription: {row.new_subscription_semantic}
                </div>
              )}
            </div>
          ))}
          {errorMsg && <div style={{ color: '#c33', fontSize: '.72rem' }}>{errorMsg}</div>}
        </div>
      )}
    </ResultCard>
  );
}

function actionLabel(t: string): string {
  switch (t) {
    case 'deactivate': return 'deactivated';
    case 'rewrite_query': return 'rewrote query';
    case 'add_catchall_subscription': return 'added sub';
    default: return t;
  }
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
