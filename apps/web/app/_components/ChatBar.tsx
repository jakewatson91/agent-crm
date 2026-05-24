'use client';

/**
 * Floating chat panel for the workspace.
 *
 * Present on every page. Defaults to closed everywhere. ⌘J toggles it.
 * Drag the top edge to resize. Esc closes.
 *
 * Hard rules (see feedback_chat_never_sidebar):
 *   - never render chat as a left/right rail
 *   - never render chat as a corner FAB
 *   - never show a persistent trigger pill at the bottom
 */

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

// Chat is ~600 lines and only renders when ⌘J is hit. Defer compile+download
// until that moment so every workspace tab doesn't pay for it on first paint.
const Chat = dynamic(() => import('./Chat').then((m) => ({ default: m.Chat })), { ssr: false });

const MIN_HEIGHT = 240;
const DEFAULT_HEIGHT = 480;

export function ChatBar() {
  const params = useParams<{ ws: string }>();
  const ws = params?.ws as string | undefined;
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragging = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape' && open) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const max = window.innerHeight * 0.85;
      const next = window.innerHeight - e.clientY;
      setHeight(Math.max(MIN_HEIGHT, Math.min(max, next)));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }

  if (!ws) return null;
  if (!open) return null;

  return (
    <div
      style={{
        height,
        background: 'var(--panel)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        style={{
          position: 'absolute', top: -3, left: 0, right: 0,
          height: 6, cursor: 'row-resize', zIndex: 2,
        }}
      />
      <ChatPaneWrap><Chat ws={ws} onClose={() => setOpen(false)} /></ChatPaneWrap>
    </div>
  );
}

// Chat sets its own border + radius. Inside the panel we want it edge-to-edge.
function ChatPaneWrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%' }} className="chatpane-inline">
      {children}
      <style>{`
        .chatpane-inline > [role="region"] {
          height: 100% !important;
          border: 0 !important;
          border-radius: 0 !important;
        }
      `}</style>
    </div>
  );
}
