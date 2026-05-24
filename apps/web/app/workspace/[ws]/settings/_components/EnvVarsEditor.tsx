'use client';

import { useState, type ClipboardEvent } from 'react';

/**
 * Render-style environment-variable editor over policy.env. Generic — no
 * predetermined names. The loop reads canonical names (OPENAI_API_KEY,
 * RESEND_API_KEY, etc.) when they're set; unknown names are stored too.
 *
 * Each row gets a secret toggle. Names matching *_KEY / *_SECRET / *_TOKEN /
 * *_PASSWORD default to masked. Masked values render as •••• once saved and
 * require explicit re-entry to update.
 */
type Row = { name: string; value: string; secret: boolean; dirty: boolean };

const SECRET_RE = /(KEY|SECRET|TOKEN|PASSWORD|PWD)$/i;

function rowsFromEnv(env: Record<string, string>): Row[] {
  return Object.entries(env ?? {}).map(([name, value]) => ({
    name,
    value,
    secret: SECRET_RE.test(name),
    dirty: false,
  }));
}

function envFromRows(rows: Row[], original: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    // If the row is masked-and-untouched, persist the original value.
    if (r.secret && !r.dirty && original[name] != null) {
      out[name] = original[name]!;
    } else {
      out[name] = r.value;
    }
  }
  return out;
}

export function EnvVarsEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [original] = useState<Record<string, string>>(value ?? {});
  const [rows, setRows] = useState<Row[]>(() => rowsFromEnv(value ?? {}));

  function emit(next: Row[]) {
    setRows(next);
    onChange(envFromRows(next, original));
  }
  function setName(i: number, name: string) {
    emit(rows.map((r, j) => j === i ? {
      ...r,
      name,
      // Auto-mask when the user types a *_KEY-style name.
      secret: r.dirty ? r.secret : SECRET_RE.test(name),
    } : r));
  }
  function setValue(i: number, value: string) {
    emit(rows.map((r, j) => j === i ? { ...r, value, dirty: true } : r));
  }
  function toggleSecret(i: number) {
    emit(rows.map((r, j) => j === i ? { ...r, secret: !r.secret } : r));
  }
  function startEdit(i: number) {
    // For a masked row, clear the visible value so the user can re-enter.
    emit(rows.map((r, j) => j === i ? { ...r, value: '', dirty: true } : r));
  }
  function removeRow(i: number) {
    emit(rows.filter((_, j) => j !== i));
  }
  function addRow() {
    emit([...rows, { name: '', value: '', secret: false, dirty: true }]);
  }

  /**
   * Render-style paste UX: if the clipboard payload looks like one or more
   * `NAME=value` lines, parse them and replace the current row + append the
   * rest. Otherwise the paste flows through to the input normally.
   *
   * Triggered from any field on the row; works whether the user pastes into
   * Name or Value because both forms ("OPENAI_API_KEY=sk-..." in either box)
   * are common muscle memory.
   *
   * Recognized: `NAME=value`, `NAME = value` (whitespace around `=`),
   *             leading `export ` (so `export NAME=value` from .env files works).
   */
  function handlePaste(i: number, e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text || !text.includes('=')) return;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed: Array<{ name: string; value: string }> = [];
    for (const line of lines) {
      const stripped = line.replace(/^export\s+/, '');
      const eq = stripped.indexOf('=');
      if (eq <= 0) continue;
      const name = stripped.slice(0, eq).trim();
      let value = stripped.slice(eq + 1).trim();
      // Trim matching surrounding quotes the way shells do.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (name) parsed.push({ name, value });
    }
    if (parsed.length === 0) return;
    e.preventDefault();
    const next = [...rows];
    // First parsed pair → replaces the row the user pasted into.
    const [first, ...rest] = parsed;
    next[i] = {
      name: first!.name,
      value: first!.value,
      secret: SECRET_RE.test(first!.name),
      dirty: true,
    };
    // Subsequent pairs append. If a name already exists in rows, update in place.
    for (const p of rest) {
      const existing = next.findIndex((r) => r.name === p.name);
      if (existing >= 0) {
        next[existing] = { ...next[existing]!, value: p.value, dirty: true };
      } else {
        next.push({ name: p.name, value: p.value, secret: SECRET_RE.test(p.name), dirty: true });
      }
    }
    emit(next);
  }

  const inputStyle: React.CSSProperties = {
    padding: '.35rem .5rem', borderRadius: 5, border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: '.8rem', width: '100%',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.4 }}>
        Tip: paste <code style={{ color: 'var(--text-2)' }}>NAME=value</code> (or a whole .env block) into any field — rows split automatically.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 70px 28px', gap: '.4rem', fontSize: '.7rem', color: 'var(--text-3)' }}>
        <span>name</span>
        <span>value</span>
        <span>secret</span>
        <span />
      </div>
      {rows.length === 0 && (
        <div style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>No env vars set. The loop falls back to process.env. Click + or paste below.</div>
      )}
      {rows.map((r, i) => {
        const masked = r.secret && !r.dirty && r.value !== '';
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '200px 1fr 70px 28px', gap: '.4rem', alignItems: 'center' }}>
            <input
              value={r.name}
              onChange={(e) => setName(i, e.target.value)}
              onPaste={(e) => handlePaste(i, e)}
              placeholder="OPENAI_API_KEY"
              style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace' }}
            />
            {masked ? (
              <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center' }}>
                <input
                  value="••••••••"
                  readOnly
                  style={{ ...inputStyle, color: 'var(--text-3)', flex: 1 }}
                />
                <button
                  onClick={() => startEdit(i)}
                  style={{ padding: '.2rem .5rem', fontSize: '.7rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text-2)', cursor: 'pointer' }}
                >Edit</button>
              </div>
            ) : (
              <input
                value={r.value}
                onChange={(e) => setValue(i, e.target.value)}
                onPaste={(e) => handlePaste(i, e)}
                type={r.secret ? 'password' : 'text'}
                placeholder="value"
                style={inputStyle}
              />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '.3rem', fontSize: '.7rem', color: 'var(--text-2)' }}>
              <input type="checkbox" checked={r.secret} onChange={() => toggleSecret(i)} />
              mask
            </label>
            <button
              onClick={() => removeRow(i)}
              aria-label="Remove env var"
              style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', fontSize: '1.1rem', padding: 0, lineHeight: 1 }}
            >×</button>
          </div>
        );
      })}
      <button
        onClick={addRow}
        style={{
          alignSelf: 'flex-start',
          padding: '.3rem .7rem', fontSize: '.75rem',
          borderRadius: 5, border: '1px dashed var(--border)',
          background: 'transparent', color: 'var(--text-2)', cursor: 'pointer',
        }}
      >+ Add env var</button>
    </div>
  );
}
