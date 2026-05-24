'use client';

import { useState, type KeyboardEvent } from 'react';

/**
 * Typed chip list — short strings, one per chip. Replaces newline-separated
 * textareas for pain_points, value_props, ask_examples, banned_phrases,
 * banned_predicates, tone_keywords.
 *
 * UX: type, press Enter (or comma) to commit a chip. Click ✕ to remove.
 */
export function ChipList({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (values.includes(v)) { setDraft(''); return; }
    onChange([...values, v]);
    setDraft('');
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '.3rem',
      padding: '.4rem', minHeight: 38,
      border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)',
    }}>
      {values.map((v, i) => (
        <span key={`${v}-${i}`} style={{
          display: 'inline-flex', alignItems: 'center', gap: '.3rem',
          padding: '.15rem .5rem', borderRadius: 999,
          background: 'var(--panel-2)', color: 'var(--text)', fontSize: '.75rem',
        }}>
          {v}
          <button
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', padding: 0, fontSize: '.85rem', lineHeight: 1 }}
            aria-label={`Remove ${v}`}
          >×</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => commit(draft)}
        placeholder={values.length === 0 ? (placeholder ?? 'Type and press Enter') : ''}
        style={{
          flex: 1, minWidth: 120, border: 0, outline: 'none',
          background: 'transparent', color: 'var(--text)', fontSize: '.8rem',
        }}
      />
    </div>
  );
}
