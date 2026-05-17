import Link from 'next/link';
import type { ReactNode } from 'react';
import { EntitySearch } from '../../_components/EntitySearch';
import { IntakeWidget } from '../../_components/IntakeWidget';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;

  // Activity is folded into Feed — same data, one place. Settings absorbs
  // Constitution (it was always config).
  const primary = [
    { href: `/workspace/${ws}/channels`, label: 'Feed',     hint: 'every action the agent took' },
    { href: `/workspace/${ws}/gates`,    label: 'Approvals', hint: 'things needing your sign-off · empty = healthy' },
  ];
  const tools = [
    { href: `/workspace/${ws}/sources`,  label: 'Sources',  hint: 'where signals come from' },
    { href: `/workspace/${ws}/agents`,   label: 'Agents',   hint: 'saved filter rules' },
    { href: `/workspace/${ws}/query`,    label: 'Query',    hint: 'ad-hoc pull' },
  ];
  const debug = [
    { href: `/workspace/${ws}/replay`,   label: 'Replay',   hint: 'time slider' },
    { href: `/workspace/${ws}/settings`, label: 'Settings', hint: 'constitution + ICP + about' },
  ];

  const linkStyle: React.CSSProperties = {
    color: 'var(--text)',
    textDecoration: 'none',
    display: 'block',
    padding: '.5rem .65rem',
    borderRadius: 6,
    transition: 'background 120ms ease',
  };

  function Section({ title, items }: { title: string; items: typeof primary }) {
    return (
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)', padding: '0 .65rem .35rem' }}>{title}</div>
        {items.map((n) => (
          <Link key={n.href} href={n.href} style={linkStyle} className="nav-link">
            <div style={{ fontSize: '.92rem', fontWeight: 500 }}>{n.label}</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{n.hint}</div>
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      <aside
        style={{
          width: 240,
          borderRight: '1px solid var(--border)',
          padding: '1.5rem 1rem',
          background: 'var(--panel)',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
          height: '100vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ padding: '0 .65rem', marginBottom: '1rem' }}>
          <div style={{ fontSize: '.95rem', fontWeight: 600, letterSpacing: '-.01em' }}>agent-crm</div>
          <div className="mono" style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>{ws.slice(0, 8)}…</div>
        </div>
        <EntitySearch ws={ws} />
        <Section title="Main" items={primary} />
        <Section title="Configure" items={tools} />
        <Section title="Audit" items={debug} />
      </aside>
      <main style={{ flex: 1, padding: '1.75rem 2rem', maxWidth: 1100 }}>{children}</main>
      <IntakeWidget />
      <style>{`
        .nav-link:hover { background: var(--panel-2); }
      `}</style>
    </div>
  );
}
