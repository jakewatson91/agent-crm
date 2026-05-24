'use client';

import type { ReactNode } from 'react';

/**
 * Single source of truth for "label + plain-English help + the input itself".
 * One row per setting; the help line answers "what changes if I change this?"
 * in one sentence. No jargon.
 */
export function HelpRow({
  label,
  help,
  children,
  badge,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem', padding: '.5rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <label style={{ fontSize: '.85rem', fontWeight: 500, color: 'var(--text)' }}>{label}</label>
        {badge}
      </div>
      {help && (
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.4 }}>{help}</div>
      )}
      <div style={{ marginTop: '.2rem' }}>{children}</div>
    </div>
  );
}
