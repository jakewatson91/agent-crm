'use client';

/**
 * Datadog-style right-docked drawer. Click a count, an entity reference, or a
 * cited fact anywhere in the app and it opens here instead of navigating away
 * — the page underneath never moves. Clicking something inside the drawer
 * pushes another layer on top (drilling in); the breadcrumb at the top pops
 * back to any earlier layer, and × clears the whole stack.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { EntityDrawerBody } from './drawer/EntityDrawerBody';
import { FactDrawerBody } from './drawer/FactDrawerBody';
import { SignalFactsDrawerBody } from './drawer/SignalFactsDrawerBody';

export type DrawerKind = 'entity' | 'fact' | 'signal_facts';

export interface DrawerTarget {
  kind: DrawerKind;
  id: string;
  label?: string;
}

interface DrawerApi {
  ws: string;
  stack: DrawerTarget[];
  push: (target: DrawerTarget) => void;
  pop: () => void;
  popTo: (index: number) => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerApi | null>(null);

const KINDS: DrawerKind[] = ['entity', 'fact', 'signal_facts'];

function stackToParam(stack: DrawerTarget[]): string {
  return stack.map((t) => `${t.kind}:${t.id}`).join(',');
}

function paramToStack(raw: string | null): DrawerTarget[] {
  if (!raw) return [];
  return raw.split(',').flatMap((seg) => {
    const [kind, id] = seg.split(':');
    return kind && id && (KINDS as string[]).includes(kind) ? [{ kind: kind as DrawerKind, id }] : [];
  });
}

export function DrawerProvider({ ws, children }: { ws: string; children: React.ReactNode }) {
  const [stack, setStack] = useState<DrawerTarget[]>([]);

  // Support opening a shared link (?panel=kind:id,kind:id) once on mount.
  // After this, drawer state is purely client-driven — see the echo effect
  // below for why we don't read the URL again.
  useEffect(() => {
    const initial = paramToStack(new URLSearchParams(window.location.search).get('panel'));
    if (initial.length) setStack(initial);
  }, []);

  // Cosmetic URL echo via history.replaceState directly — NOT next/navigation's
  // router, so opening/closing a drawer never triggers a server re-render of
  // the page underneath it. Copy/paste-able, doesn't drive React state back.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (stack.length) url.searchParams.set('panel', stackToParam(stack));
    else url.searchParams.delete('panel');
    window.history.replaceState(null, '', url.toString());
  }, [stack]);

  const push = useCallback((target: DrawerTarget) => setStack((s) => [...s, target]), []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const popTo = useCallback((index: number) => setStack((s) => s.slice(0, index + 1)), []);
  const close = useCallback(() => setStack([]), []);

  useEffect(() => {
    if (!stack.length) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') pop();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack.length, pop]);

  const api = useMemo<DrawerApi>(() => ({ ws, stack, push, pop, popTo, close }), [ws, stack, push, pop, popTo, close]);

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <DrawerHost />
    </DrawerContext.Provider>
  );
}

export function useDrawer(): DrawerApi {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error('useDrawer must be used within a DrawerProvider');
  return ctx;
}

function crumbLabel(t: DrawerTarget): string {
  if (t.label) return t.label;
  if (t.kind === 'signal_facts') return 'facts';
  return t.kind;
}

function DrawerHost() {
  const { ws, stack, pop, popTo, close } = useDrawer();
  const open = stack.length > 0;
  const top = stack[stack.length - 1];

  return (
    <div
      aria-hidden={!open}
      onClick={close}
      style={{ ...overlay, pointerEvents: open ? 'auto' : 'none', opacity: open ? 1 : 0 }}
    >
      <div onClick={(e) => e.stopPropagation()} className="drawer-panel" style={{ ...panel, transform: open ? 'translateX(0)' : 'translateX(100%)' }}>
        {open && top && (
          <>
            <div style={breadcrumbRow}>
              {stack.map((t, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem', minWidth: 0 }}>
                  {i > 0 && <span className="subtle">/</span>}
                  <button
                    onClick={() => popTo(i)}
                    style={{
                      ...crumbBtn,
                      fontWeight: i === stack.length - 1 ? 600 : 500,
                      color: i === stack.length - 1 ? 'var(--text)' : 'var(--text-2)',
                    }}
                  >
                    {crumbLabel(t)}
                  </button>
                </span>
              ))}
              <button onClick={close} aria-label="Close" style={closeBtn}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' }}>
              {top.kind === 'entity' && <EntityDrawerBody ws={ws} entityId={top.id} />}
              {top.kind === 'fact' && <FactDrawerBody factId={top.id} />}
              {top.kind === 'signal_facts' && <SignalFactsDrawerBody signalId={top.id} />}
            </div>
          </>
        )}
      </div>
      <style>{`
        .drawer-panel { transition: transform 200ms ease; }
        @media (prefers-reduced-motion: reduce) { .drawer-panel { transition: none; } }
      `}</style>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(20,18,14,0.45)', zIndex: 200,
  display: 'flex', justifyContent: 'flex-end', transition: 'opacity 160ms ease',
};
const panel: React.CSSProperties = {
  width: '50vw', minWidth: 480, maxWidth: '92vw', height: '100vh', background: 'var(--panel)',
  borderLeft: '1px solid var(--border)', boxShadow: '-12px 0 40px rgba(20,18,14,0.18)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const breadcrumbRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '.3rem', flexWrap: 'wrap',
  padding: '.85rem 1rem', borderBottom: '1px solid var(--border)', flexShrink: 0,
};
const crumbBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: '.82rem',
};
const closeBtn: React.CSSProperties = {
  marginLeft: 'auto', background: 'transparent', border: 0, color: 'var(--text-3)',
  fontSize: '1.4rem', lineHeight: 1, cursor: 'pointer', padding: 0, flexShrink: 0,
};
