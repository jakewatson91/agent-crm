'use client';

import { useEffect, useState } from 'react';
import { RichTextEditor } from './RichTextEditor';

// Escape plain text and turn newlines into <br> so the draft seeds the rich
// editor as readable HTML (the drafter emits plain text; formatting is the
// user's to add here before sending).
function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc.replace(/\n/g, '<br>');
}

interface Gate {
  id: string;
  policy: string;
  condition: {
    to_email?: string | null;
    subject?: string;
    body?: string;
    entity_id?: string;
    entity_name?: string;
  } | null;
  decision: 'approve' | 'reject' | 'modify' | null;
  decided_at: string | null;
}

interface Props {
  postId: string;
  workspaceId: string;
  onDecided?: () => void;
}

type Mode = 'idle' | 'editing' | 'rejecting' | 'sent' | 'rejected' | 'no_gate';

const PILL_BASE: React.CSSProperties = {
  padding: '.3rem .7rem', fontSize: '.78rem', border: 'none',
  cursor: 'pointer', borderRadius: 4, fontWeight: 500,
};

export function DraftActions({ postId, workspaceId, onDecided }: Props) {
  const [gate, setGate] = useState<Gate | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [editedSubject, setEditedSubject] = useState('');
  const [editedHtml, setEditedHtml] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentInfo, setSentInfo] = useState<{ effective_to: string; override_active: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/gates/by-post?post_id=${postId}`)
      .then((r) => r.json())
      .then((j: { gate: Gate | null }) => {
        if (!alive) return;
        if (!j.gate) { setMode('no_gate'); return; }
        setGate(j.gate);
        if (j.gate.decided_at) {
          setMode(j.gate.decision === 'approve' || j.gate.decision === 'modify' ? 'sent' : 'rejected');
        }
      })
      .catch(() => alive && setMode('no_gate'));
    return () => { alive = false; };
  }, [postId]);

  // No gate (legacy drafts created before C2 shipped) — hide silently.
  if (mode === 'no_gate' || !gate) {
    return mode === 'no_gate' ? null : <span className="subtle" style={{ fontSize: '.72rem' }}>loading…</span>;
  }

  const condSubject = gate.condition?.subject ?? '';
  const condBody = gate.condition?.body ?? '';
  const intendedTo = gate.condition?.to_email ?? null;

  async function decide(decision: 'approve' | 'reject', overrides?: { edited_subject?: string; edited_html?: string; reason?: string }) {
    if (!gate) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/gates/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, gate_id: gate.id, decision, ...overrides }),
      });
      const j = await res.json() as { ok?: boolean; error?: string; sent?: { effective_to: string; override_active: boolean } };
      if (!res.ok) { setError(j.error ?? `error ${res.status}`); return; }
      if (decision === 'approve') {
        setSentInfo(j.sent ?? null);
        setMode('sent');
      } else {
        setMode('rejected');
      }
      onDecided?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  if (mode === 'sent') {
    return (
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '.5rem' }}>
        <span className="badge badge-green">sent ✓</span>
        {sentInfo && (
          <span className="subtle mono" style={{ fontSize: '.7rem' }}>
            → {sentInfo.effective_to}{sentInfo.override_active && intendedTo && ` (override; intended ${intendedTo})`}
          </span>
        )}
      </div>
    );
  }
  if (mode === 'rejected') {
    return (
      <div style={{ marginTop: '.5rem' }}>
        <span className="badge badge-coral">rejected</span>
      </div>
    );
  }

  if (mode === 'editing') {
    return (
      <div style={{ marginTop: '.5rem', padding: '.6rem .75rem', background: 'var(--panel-2)', borderLeft: '3px solid var(--accent-blue)', borderRadius: 4 }}>
        <div className="subtle" style={{ fontSize: '.68rem', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>edit before send</div>
        <input
          value={editedSubject}
          onChange={(e) => setEditedSubject(e.target.value)}
          placeholder="subject"
          style={{ width: '100%', padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', marginBottom: '.5rem' }}
        />
        <RichTextEditor initialHtml={editedHtml} onChange={setEditedHtml} />
        <div style={{ display: 'flex', gap: '.5rem', marginTop: '.5rem' }}>
          <button
            onClick={() => decide('approve', { edited_subject: editedSubject, edited_html: editedHtml })}
            disabled={busy}
            style={{ ...PILL_BASE, background: 'var(--accent-green)', color: '#fff', opacity: busy ? 0.4 : 1 }}
          >
            {busy ? 'sending…' : 'send edited'}
          </button>
          <button
            onClick={() => setMode('idle')}
            disabled={busy}
            style={{ ...PILL_BASE, background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            cancel
          </button>
        </div>
        {error && <div style={{ marginTop: '.4rem', color: 'var(--accent-coral)', fontSize: '.78rem' }}>{error}</div>}
      </div>
    );
  }

  if (mode === 'rejecting') {
    return (
      <div style={{ marginTop: '.5rem', padding: '.6rem .75rem', background: 'var(--panel-2)', borderRadius: 4 }}>
        <input
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="reason (optional)"
          style={{ width: '100%', padding: '.4rem .55rem', fontSize: '.85rem', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', marginBottom: '.4rem' }}
        />
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button
            onClick={() => decide('reject', { reason: rejectReason })}
            disabled={busy}
            style={{ ...PILL_BASE, background: 'var(--accent-coral)', color: '#fff', opacity: busy ? 0.4 : 1 }}
          >
            {busy ? '…' : 'confirm reject'}
          </button>
          <button
            onClick={() => setMode('idle')}
            disabled={busy}
            style={{ ...PILL_BASE, background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            cancel
          </button>
        </div>
        {error && <div style={{ marginTop: '.4rem', color: 'var(--accent-coral)', fontSize: '.78rem' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.5rem', flexWrap: 'wrap' }}>
      <button
        onClick={() => decide('approve')}
        disabled={busy}
        style={{ ...PILL_BASE, background: 'var(--accent-green)', color: '#fff', opacity: busy ? 0.4 : 1 }}
      >
        {busy ? 'sending…' : 'accept · send'}
      </button>
      <button
        onClick={() => { setEditedSubject(condSubject); setEditedHtml(textToHtml(condBody)); setMode('editing'); }}
        disabled={busy}
        style={{ ...PILL_BASE, background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)' }}
      >
        edit
      </button>
      <button
        onClick={() => setMode('rejecting')}
        disabled={busy}
        style={{ ...PILL_BASE, background: 'transparent', color: 'var(--accent-coral)', border: '1px solid var(--accent-coral)' }}
      >
        reject
      </button>
      {intendedTo && (
        <span className="subtle mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
          intended: {intendedTo}
        </span>
      )}
      {error && <div style={{ marginTop: '.4rem', color: 'var(--accent-coral)', fontSize: '.78rem', width: '100%' }}>{error}</div>}
    </div>
  );
}
