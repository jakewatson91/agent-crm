'use client';

import { useDrawer } from '../Drawer';

/**
 * Drop-in replacement for `<Link href=".../entities/{id}">` that opens the
 * entity in the drawer instead of navigating away from the page. Pass
 * `className` for pill-shaped triggers (e.g. "chip") — a plain-text trigger
 * (no className) gets its button chrome reset so it reads exactly like the
 * `<a>` it replaces.
 */
export function EntityLink({
  id, label, className, style, title, children,
}: {
  id: string;
  label: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  children: React.ReactNode;
}) {
  const { push } = useDrawer();
  const base: React.CSSProperties = className ? {} : { background: 'transparent', border: 'none', padding: 0, textAlign: 'left' };
  return (
    <button onClick={() => push({ kind: 'entity', id, label })} className={className} title={title} style={{ ...base, ...style }}>
      {children}
    </button>
  );
}
