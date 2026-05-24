import Link from 'next/link';
import type { ReactNode } from 'react';
import { EntitySearch } from '../../_components/EntitySearch';
import { ChatBar } from '../../_components/ChatBar';
import { StatusBar } from '../../_components/StatusBar';
import { WorkspaceShell } from '../../_components/WorkspaceShell';
import { NavLinkPrefetch } from '../../_components/NavLinkPrefetch';
import { PageContextProvider } from '../../_components/PageContext';
import { requireRole } from '../../_lib/auth';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  await requireRole(ws, 'viewer');

  const workspace = [
    { href: `/workspace/${ws}/feed`,     label: 'Feed',      hint: 'every action the agent took',                       prefetchUrl: `/api/feed/list?workspace_id=${ws}` },
    { href: `/workspace/${ws}/entities`, label: 'Entities',  hint: 'everything in the system, by kind',                 prefetchUrl: `/api/entities/index?workspace_id=${ws}` },
    { href: `/workspace/${ws}/gates`,    label: 'Approvals', hint: 'things needing your sign-off · empty = healthy',    prefetchUrl: `/api/gates/list?workspace_id=${ws}` },
  ];
  const setup = [
    { href: `/workspace/${ws}/sources`,  label: 'Sources',  hint: 'where signals come from',                            prefetchUrl: `/api/sources/list?workspace_id=${ws}` },
    { href: `/workspace/${ws}/settings`, label: 'Settings', hint: 'about, writing style, thresholds' },
  ];
  const audit = [
    { href: `/workspace/${ws}/replay`,   label: 'Replay',   hint: 'time slider over events' },
  ];

  const linkStyle: React.CSSProperties = {
    color: 'var(--text)',
    textDecoration: 'none',
    display: 'block',
    padding: '.5rem .65rem',
    borderRadius: 6,
    transition: 'background 120ms ease',
  };

  type NavItem = { href: string; label: string; hint: string; prefetchUrl?: string };
  function Section({ title, items }: { title: string; items: NavItem[] }) {
    return (
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)', padding: '0 .65rem .35rem' }}>{title}</div>
        {items.map((n) => (
          <NavLinkPrefetch key={n.href} href={n.href} prefetchUrl={n.prefetchUrl} style={linkStyle} className="nav-link">
            <div style={{ fontSize: '.92rem', fontWeight: 500 }}>{n.label}</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{n.hint}</div>
          </NavLinkPrefetch>
        ))}
      </div>
    );
  }

  const sidebar = (
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
        flexShrink: 0,
      }}
    >
      <Link href={`/workspace/${ws}`} style={{ display: 'block', padding: '0 .65rem', marginBottom: '1rem', textDecoration: 'none', color: 'var(--text)' }}>
        <div style={{ fontSize: '.95rem', fontWeight: 600, letterSpacing: '-.01em' }}>
          <span style={{ color: 'var(--accent)', marginRight: '.35rem' }}>✦</span>agent-crm
        </div>
        <div className="mono" style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>{ws.slice(0, 8)}…</div>
      </Link>
      <EntitySearch ws={ws} />
      <Section title="Workspace" items={workspace} />
      <Section title="Setup" items={setup} />
      <Section title="Audit" items={audit} />
    </aside>
  );

  return (
    <>
      <PageContextProvider>
        <WorkspaceShell sidebar={sidebar}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.75rem 2rem', minHeight: 0 }}>{children}</div>
          <ChatBar />
          <StatusBar />
        </WorkspaceShell>
      </PageContextProvider>
      <style>{`
        .nav-link:hover { background: var(--panel-2); }
      `}</style>
    </>
  );
}
