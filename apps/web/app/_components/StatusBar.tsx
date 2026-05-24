'use client';

/**
 * Slim status bar at the bottom of the workspace.
 *
 * Surfaces the keybindings (⌘J chat, ⌘B sidebar) and current workspace id,
 * VS Code style. Always visible so users discover the chat without needing
 * an always-on trigger pill at the bottom.
 */

import { useParams } from 'next/navigation';

export function StatusBar() {
  const params = useParams<{ ws: string }>();
  const ws = params?.ws as string | undefined;

  const kbd: React.CSSProperties = {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: '.65rem',
    color: 'var(--text-2)',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    padding: '.05rem .3rem',
    borderRadius: 3,
    marginRight: '.3rem',
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 26,
        padding: '0 .9rem',
        background: 'var(--panel)',
        borderTop: '1px solid var(--border)',
        fontSize: '.72rem',
        color: 'var(--text-3)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <span><span style={kbd}>⌘J</span>chat</span>
        <span><span style={kbd}>⌘B</span>sidebar</span>
      </div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '.68rem' }}>
        {ws ? `${ws.slice(0, 8)}…` : ''}
      </div>
    </div>
  );
}
