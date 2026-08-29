'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Typed chip list — short strings, one per chip. Replaces newline-separated
 * textareas for pain_points, value_props, ask_examples, banned_phrases,
 * banned_predicates, tone_keywords.
 *
 * UX: type, press Enter (or comma) to commit a chip. Click ✕ to remove.
 *
 * Some of these lists do not hold short strings. "Never sell to" holds a
 * paragraph per entry, and as pills those wrapped into unreadable blobs with no
 * way to fix a typo except deleting the paragraph and retyping it. Any entry
 * past SENTENCE_LEN gets its own full-width editable row instead. The switch is
 * on the length of what is actually in the list, so every short list keeps the
 * pills it had.
 */

/** Longer than this and it is a sentence, not a tag. */
const SENTENCE_LEN = 60;
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

  function edit(i: number, v: string) {
    onChange(values.map((x, j) => (j === i ? v : x)));
  }

  if (values.some((v) => v.length > SENTENCE_LEN)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
        {values.map((v, i) => (
          <div key={i} style={{ display: 'flex', gap: '.4rem', alignItems: 'flex-start' }}>
            <GrowingRow value={v} onChange={(next) => edit(i, next)} />
            <button
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', padding: '.4rem .2rem', fontSize: '.9rem', lineHeight: 1 }}
              aria-label={`Remove entry ${i + 1}`}
            >×</button>
          </div>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => commit(draft)}
          placeholder={placeholder ?? 'Type and press Enter'}
          style={{
            width: '100%', padding: '.4rem .5rem', fontSize: '.8rem',
            border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg)', color: 'var(--text)',
          }}
        />
      </div>
    );
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

/** A sentence-length entry, sized to its own text so none of it is hidden. */
function GrowingRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      style={{
        flex: 1, fontSize: '.78rem', lineHeight: 1.5, padding: '.4rem .5rem',
        resize: 'none', overflow: 'hidden',
        border: '1px solid var(--border)', borderRadius: 6,
        background: 'var(--bg)', color: 'var(--text)',
      }}
    />
  );
}
