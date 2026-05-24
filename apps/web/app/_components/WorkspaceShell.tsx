'use client';

/**
 * Client shell that wraps the workspace sidebar + main content.
 *
 * Owns the toggle state for the sidebar so we can bind ⌘B to collapse it
 * (VS Code convention). ⌘J toggles the chat bar (handled in ChatBar).
 *
 * The sidebar is rendered server-side and passed in as a React node — this
 * component only controls whether to render it.
 */

import { useEffect, useState, type ReactNode } from 'react';

export function WorkspaceShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      {sidebarOpen && sidebar}
      <main
        style={{
          flex: 1,
          maxWidth: sidebarOpen ? 1100 : undefined,
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          overflow: 'hidden',
        }}
      >
        {children}
      </main>
    </div>
  );
}
