'use client';

/**
 * Slim status bar at the bottom of the workspace.
 *
 * Surfaces the keybindings (⌘J chat, ⌘B sidebar), a light/dark theme toggle,
 * and the current workspace id, VS Code style. Always visible so users discover
 * the chat without needing an always-on trigger pill at the bottom.
 */

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function StatusBar() {
  const params = useParams<{ ws: string }>();
  const ws = params?.ws as string | undefined;
  const [theme, setTheme] = useState<Theme>('light');

  // Sync the icon to whatever the no-flash script (or the OS) settled on.
  useEffect(() => { setTheme(currentTheme()); }, []);

  function toggleTheme() {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
    setTheme(next);
  }

  const kbd: React.CSSProperties = {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '.9rem' }}>
        <button
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          style={{
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--text-3)', fontSize: '.72rem', display: 'flex', alignItems: 'center', gap: '.3rem',
          }}
        >
          <span style={{ fontSize: '.8rem' }}>{theme === 'dark' ? '☾' : '☀'}</span>
          {theme === 'dark' ? 'dark' : 'light'}
        </button>
        <span style={{ fontSize: '.68rem' }}>
          {ws ? `${ws.slice(0, 8)}…` : ''}
        </span>
      </div>
    </div>
  );
}
