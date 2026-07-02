'use client';

import type { ConnectorEntry } from './ConnectorHub';

const ACCENT: Record<string, string> = {
  blue: 'var(--accent-blue)', green: 'var(--accent-green)', amber: 'var(--accent-amber)',
  coral: 'var(--accent-coral)', purple: 'var(--accent-purple)',
};

function StatusPill({ c }: { c: ConnectorEntry }) {
  if (c.state.health === 'error') return <span className="badge badge-coral">issue</span>;
  if (c.state.configured) {
    const serverOnly = c.state.from_server.length > 0;
    return <span className={serverOnly ? 'badge badge-blue' : 'badge badge-green'}>{serverOnly ? 'server env' : 'connected'}</span>;
  }
  return <span className="badge badge-mute">not connected</span>;
}

export function ConnectorCard({ connector, onOpen }: { connector: ConnectorEntry; onOpen: () => void }) {
  const c = connector;
  const accent = ACCENT[c.accent] ?? 'var(--accent-blue)';
  return (
    <button onClick={onOpen} style={card} className="connector-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <div style={{ ...icon, background: accent }}>{c.name[0]}</div>
        <div style={{ fontWeight: 600, fontSize: '.92rem', flex: 1, textAlign: 'left' }}>{c.name}</div>
        <StatusPill c={c} />
      </div>
      <div style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.45, textAlign: 'left', flex: 1 }}>{c.blurb}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', minHeight: 20 }}>
        {c.state.role && (
          <span className={c.state.role === 'primary' ? 'badge badge-blue' : 'badge badge-mute'}>
            {c.state.role}
          </span>
        )}
        {c.state.alert && (
          <span style={{ fontSize: '.72rem', color: '#a14d44', textAlign: 'left' }}>⚠ {c.state.alert.message}</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '.76rem', color: 'var(--text-3)' }}>{c.state.configured || c.state.role ? 'Manage →' : 'Connect →'}</span>
      </div>
    </button>
  );
}

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '.55rem',
  padding: '.9rem 1rem', background: 'var(--panel)', border: '1px solid var(--border)',
  borderRadius: 10, cursor: 'pointer', minHeight: 132, width: '100%', textAlign: 'left', font: 'inherit',
};
const icon: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, color: '#fff', display: 'flex', alignItems: 'center',
  justifyContent: 'center', fontWeight: 700, fontSize: '.95rem', flexShrink: 0,
};
