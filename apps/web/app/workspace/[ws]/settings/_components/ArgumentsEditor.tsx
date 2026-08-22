'use client';

import type { DrafterArgument } from '@agent-crm/tools';

/**
 * Edit the arguments this workspace makes.
 *
 * Every other derived field is a component of a message. This is the reason to
 * send one, and until it existed the drafter worked the reason out fresh on
 * every message from a paragraph describing how the product works. That is how
 * one workspace sent 26 messages making the same wrong offer.
 *
 * The confirm control is the load-bearing part of this screen, not the text
 * boxes. An argument the wizard guessed has never met a real account, so the
 * drafter writes three messages under it and stops. Confirming is the customer
 * saying the three drafts made sense, and it is the only thing that lets the
 * argument run across the whole book. Editing any of the four fields clears
 * that confirmation, because a changed argument is a new one.
 */

const FIELDS: Array<{ key: 'when' | 'only_if' | 'so' | 'ask'; label: string; help: string }> = [
  { key: 'when', label: 'When', help: 'The dated event at their company that makes this worth sending. Has to be something findable from outside: a launch, a hire, a filing, a page on their site.' },
  { key: 'only_if', label: 'Only if', help: 'What has to be separately true about them before the claim below is honest. Leave empty only if the claim holds for every account you would ever contact.' },
  { key: 'so', label: 'So', help: 'What that event costs them, in terms of their business. Not what you sell.' },
  { key: 'ask', label: 'Ask', help: 'The one change you want them to make. Small enough that a stranger would agree to it.' },
];

export function ArgumentsEditor({
  values,
  onChange,
  showConfirm = true,
}: {
  values: DrafterArgument[];
  onChange: (next: DrafterArgument[]) => void;
  /**
   * Hidden during setup. Confirming means "I read the three drafts this wrote
   * and they make sense", and at setup there are no drafts yet, so offering the
   * checkbox there would ask someone to vouch for something that does not exist.
   */
  showConfirm?: boolean;
}) {
  function patch(i: number, field: 'when' | 'only_if' | 'so' | 'ask', v: string) {
    onChange(values.map((a, j) => {
      if (j !== i) return a;
      const next = { ...a, [field]: v };
      // A confirmation is about the words that were confirmed. Change them and
      // it goes back to three drafts and a look.
      delete next.proven_at;
      return next;
    }));
  }

  function setConfirmed(i: number, on: boolean) {
    onChange(values.map((a, j) => {
      if (j !== i) return a;
      const next = { ...a };
      if (on) next.proven_at = new Date().toISOString();
      else delete next.proven_at;
      return next;
    }));
  }

  function add() {
    onChange([...values, { id: `argument_${values.length + 1}`, label: '', when: '', so: '', ask: '', enabled: true }]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
      {values.length === 0 && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          No arguments. The drafter falls back to picking one of your pain points and working out the
          connection itself on every message.
        </div>
      )}

      {values.map((a, i) => (
        <div key={a.id ?? i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.6rem .7rem', background: 'var(--panel)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.5rem' }}>
            <input
              value={a.label ?? ''}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              placeholder="Short name for this argument"
              style={{
                flex: 1, fontSize: '.85rem', fontWeight: 600, padding: '.25rem .4rem',
                border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: 'var(--text)',
              }}
            />
            <span style={{
              fontSize: '.65rem', padding: '.1rem .45rem', borderRadius: 999,
              background: a.proven_at ? 'var(--accent-green-soft)' : 'var(--accent-amber-soft)',
              color: a.proven_at ? 'var(--badge-green-fg)' : 'var(--badge-amber-fg)',
            }}>
              {a.proven_at ? 'confirmed' : 'writes 3, then waits'}
            </span>
            <button
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', fontSize: '.9rem', lineHeight: 1 }}
              aria-label="Remove this argument"
            >×</button>
          </div>

          {FIELDS.map((f) => (
            <div key={f.key} style={{ marginBottom: '.5rem' }}>
              <div style={{ fontSize: '.7rem', color: 'var(--text-2)', marginBottom: '.15rem' }}>{f.label}</div>
              <textarea
                value={(a[f.key] ?? '') as string}
                onChange={(e) => patch(i, f.key, e.target.value)}
                rows={2}
                placeholder={f.help}
                style={{
                  width: '100%', fontSize: '.78rem', padding: '.35rem .45rem', resize: 'vertical',
                  border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)',
                }}
              />
            </div>
          ))}

          {showConfirm && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.75rem', color: 'var(--text-2)' }}>
              <input type="checkbox" checked={Boolean(a.proven_at)} onChange={(e) => setConfirmed(i, e.target.checked)} />
              I have read the drafts this wrote and they make sense. Use it on the whole book.
            </label>
          )}
        </div>
      ))}

      <div>
        <button
          onClick={add}
          style={{
            fontSize: '.75rem', padding: '.3rem .6rem', cursor: 'pointer',
            border: '1px solid var(--border)', borderRadius: 5, background: 'var(--panel-2)', color: 'var(--text-2)',
          }}
        >+ Add an argument</button>
      </div>
    </div>
  );
}
