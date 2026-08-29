'use client';

import { useState } from 'react';

/**
 * What a person knows that no search can buy.
 *
 * This is the one human input the research loop cannot replace: what someone
 * said on a call, at an event, in a room. It is not a dashboard — the note goes
 * straight into the same facts table research writes to, and the agent reads it
 * exactly like anything it found itself.
 *
 * The date field is the part that matters and the part nobody would guess, so
 * it is explained inline rather than labelled. A message needs a dated event to
 * open on; a note with a date can become the reason the agent writes to this
 * account, and a note without one is background that still raises the score and
 * informs the argument.
 */
export function NoteBox({ entityId, entityName, onSaved }: {
  entityId: string;
  entityName: string;
  onSaved?: () => void;
}) {
  const [note, setNote] = useState('');
  const [happenedAt, setHappenedAt] = useState('');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const canSave = note.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          note,
          happened_at: happenedAt || null,
          source: source || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: j.error ?? 'could not save' });
        return;
      }
      setResult({
        ok: true,
        message: j.can_anchor_outreach
          ? 'Saved. Dated, so the agent can open a message on this.'
          : 'Saved as background. Add a date if this happened on a day and you want the agent able to write about it.',
      });
      setNote('');
      setHappenedAt('');
      setSource('');
      onSaved?.();
    } catch {
      setResult({ ok: false, message: 'could not reach the server' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '1rem', padding: '.8rem .9rem' }}>
      <div
        className="subtle"
        style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.5rem' }}
      >
        something you know
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={`What did you learn about ${entityName}? A call, a conversation, something they told you.`}
        rows={3}
        style={{
          width: '100%', resize: 'vertical', padding: '.5rem .6rem',
          fontSize: '.85rem', fontFamily: 'inherit', lineHeight: 1.45,
          background: 'var(--bg-1)', color: 'var(--text-1)',
          border: '1px solid var(--border)', borderRadius: 6,
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); }}
      />

      <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '.55rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
          <span className="subtle" style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
            when it happened (optional)
          </span>
          <input
            type="date"
            value={happenedAt}
            onChange={(e) => setHappenedAt(e.target.value)}
            style={{
              padding: '.35rem .5rem', fontSize: '.78rem',
              background: 'var(--bg-1)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '.2rem', flex: '1 1 12rem' }}>
          <span className="subtle" style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
            where it came from (optional)
          </span>
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="call with their VP Eng"
            style={{
              width: '100%', padding: '.35rem .5rem', fontSize: '.78rem',
              background: 'var(--bg-1)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}
          />
        </label>

        <button
          onClick={save}
          disabled={!canSave}
          style={{
            padding: '.4rem .9rem', fontSize: '.8rem', borderRadius: 6,
            border: '1px solid var(--border)',
            background: canSave ? 'var(--accent-blue)' : 'var(--bg-2)',
            color: canSave ? '#fff' : 'var(--text-3)',
            cursor: canSave ? 'pointer' : 'default',
          }}
        >
          {saving ? 'saving…' : 'save'}
        </button>
      </div>

      <div className="subtle" style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: '.5rem' }}>
        Dating a note is what lets the agent open a message on it. Undated notes still
        count as evidence and shape what it argues.
      </div>

      {result && (
        <div
          style={{
            marginTop: '.55rem', fontSize: '.76rem',
            color: result.ok ? 'var(--text-2)' : 'var(--accent-red, #d66)',
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}
