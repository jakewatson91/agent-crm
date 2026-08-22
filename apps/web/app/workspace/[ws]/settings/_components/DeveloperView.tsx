'use client';

import { useState } from 'react';

/**
 * Collapsed-by-default view of the raw policy JSON. Read-only until the user
 * explicitly unlocks it ("I know what I'm doing"). When unlocked, the
 * friendly forms above should be locked to prevent the silent-clobber bug
 * that the previous Advanced tab had.
 */
export function DeveloperView({
  policy,
  workspaceMeta,
  unlocked,
  onUnlockChange,
  onPolicyChange,
}: {
  policy: Record<string, unknown>;
  workspaceMeta: { id: string; created_at?: string; updated_at?: string };
  unlocked: boolean;
  onUnlockChange: (next: boolean) => void;
  onPolicyChange: (next: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(policy ?? {}, null, 2));
  const [parseErr, setParseErr] = useState<string | null>(null);

  function commit(s: string) {
    setText(s);
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setParseErr(null);
        onPolicyChange(parsed);
      } else {
        setParseErr('top-level must be an object');
      }
    } catch (e) {
      setParseErr((e as Error).message);
    }
  }

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.5rem .75rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '.85rem', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <span>Developer view</span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>raw policy json + workspace metadata</span>
      </summary>
      <div style={{ marginTop: '.6rem', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          workspace_id: {workspaceMeta.id}<br />
          created_at: {workspaceMeta.created_at ?? '?'}<br />
          updated_at: {workspaceMeta.updated_at ?? '?'}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.75rem', color: '#c33' }}>
          <input type="checkbox" checked={unlocked} onChange={(e) => onUnlockChange(e.target.checked)} />
          Unlock to edit. The friendly forms above will be read-only while this is on.
        </label>
        <textarea
          value={text}
          onChange={(e) => commit(e.target.value)}
          readOnly={!unlocked}
          rows={20}
          style={{
            width: '100%', fontFamily: 'var(--font-mono)', fontSize: '.75rem',
            padding: '.5rem', borderRadius: 5, border: '1px solid var(--border)',
            background: unlocked ? 'var(--bg)' : 'var(--panel)', color: 'var(--text)',
            resize: 'vertical',
          }}
        />
        {parseErr && <div style={{ color: '#c33', fontSize: '.7rem' }}>parse error: {parseErr}</div>}
      </div>
    </details>
  );
}
