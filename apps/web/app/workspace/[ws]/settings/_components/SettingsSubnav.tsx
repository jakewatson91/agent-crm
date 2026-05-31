'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS: Array<{ slug: string; label: string; hint: string }> = [
  { slug: 'workspace',    label: 'Workspace',    hint: 'About, writing, thresholds' },
  { slug: 'members',      label: 'Members',      hint: 'Invites and roles' },
  { slug: 'api-keys',     label: 'API keys',     hint: 'Tokens for external agents' },
  { slug: 'import',       label: 'Import',       hint: 'Bring data in from a CSV' },
  { slug: 'integrations', label: 'Integrations', hint: 'Connected services' },
  { slug: 'developer',    label: 'Developer',    hint: 'Env vars, raw policy' },
];

export function SettingsSubnav({ ws }: { ws: string }) {
  const pathname = usePathname();
  return (
    <nav
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        paddingRight: '1rem',
        position: 'sticky',
        top: '1.75rem',
        alignSelf: 'flex-start',
      }}
    >
      <div style={{ fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)', padding: '0 .65rem .5rem' }}>Settings</div>
      {SECTIONS.map((s) => {
        const href = `/workspace/${ws}/settings/${s.slug}`;
        const active = pathname?.startsWith(href);
        return (
          <Link
            key={s.slug}
            href={href}
            style={{
              display: 'block',
              padding: '.5rem .65rem',
              borderRadius: 6,
              textDecoration: 'none',
              background: active ? 'var(--panel-2)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-2)',
              marginBottom: 2,
            }}
          >
            <div style={{ fontSize: '.88rem', fontWeight: active ? 500 : 400 }}>{s.label}</div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 1 }}>{s.hint}</div>
          </Link>
        );
      })}
    </nav>
  );
}
