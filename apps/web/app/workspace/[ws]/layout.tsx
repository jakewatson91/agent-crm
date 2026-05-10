import Link from 'next/link';
import type { ReactNode } from 'react';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const nav = [
    { href: `/workspace/${ws}/gates`, label: 'Gates', hint: 'inbox · empty = healthy' },
    { href: `/workspace/${ws}/activity`, label: 'Activity', hint: 'ambient feed' },
    { href: `/workspace/${ws}/channels`, label: 'Channels', hint: 'per-account threads' },
    { href: `/workspace/${ws}/sources`, label: 'Sources', hint: 'where signals come from' },
    { href: `/workspace/${ws}/agents`, label: 'Agents', hint: 'saved filter rules' },
    { href: `/workspace/${ws}/query`, label: 'Query', hint: 'ad-hoc pull' },
    { href: `/workspace/${ws}/replay`, label: 'Replay', hint: 'time slider' },
    { href: `/workspace/${ws}/settings`, label: 'Constitution', hint: 'workspace-wide rules' },
  ];
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 260, borderRight: '1px solid #1f1f1f', padding: '1.5rem 1rem' }}>
        <div style={{ fontSize: '.85rem', color: '#666', marginBottom: '1.5rem' }}>workspace</div>
        <div style={{ fontSize: '.95rem', marginBottom: '2rem' }}>{ws.slice(0, 8)}…</div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
          {nav.map((n) => (
            <Link key={n.href} href={n.href} style={{ color: '#e5e5e5', textDecoration: 'none' }}>
              <div style={{ fontSize: '.95rem' }}>{n.label}</div>
              <div style={{ fontSize: '.75rem', color: '#666' }}>{n.hint}</div>
            </Link>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, padding: '1.5rem' }}>{children}</main>
    </div>
  );
}
