'use client';

/**
 * Page context bus.
 *
 * Each tab page publishes a small description of what the user is currently
 * looking at via useSetPageContext({ tab, summary, visible? }). The chat reads
 * the current value with useCurrentPageContext() and sends it on every turn
 * so the agent can resolve "the first one" / "this" against what's on screen.
 *
 * Snapshot-on-send, not streaming. If the user navigates while the agent is
 * thinking, the next turn picks up the new context.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type PageContextVisible = {
  kind: string;
  id: string;
  label?: string;
};

export type PageContext = {
  tab: string;
  summary: string;
  visible?: PageContextVisible[];
  data?: Record<string, unknown>;
};

type Store = {
  get: () => PageContext | null;
  set: (ctx: PageContext | null) => void;
};

const StoreContext = createContext<Store | null>(null);

export function PageContextProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<PageContext | null>(null);
  // Bump a counter so consumers (Chat) re-render when context changes. We
  // intentionally don't put the PageContext itself in state — readers only
  // need the latest value at send time, not every keystroke.
  const [, setTick] = useState(0);

  const store = useMemo<Store>(
    () => ({
      get: () => ref.current,
      set: (ctx) => {
        ref.current = ctx;
        setTick((n) => n + 1);
      },
    }),
    [],
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/**
 * Tab pages call this in render with the current context. It publishes on
 * mount + on changes, and clears on unmount so a stale tab's context never
 * leaks into the next page.
 *
 * Pass a stable object (memoize upstream) — or accept that we publish on
 * every render, which is fine because the store is a ref.
 */
export function useSetPageContext(ctx: PageContext | null): void {
  const store = useContext(StoreContext);
  useEffect(() => {
    if (!store) return;
    store.set(ctx);
    return () => {
      // Only clear if our value is still the latest one.
      if (store.get() === ctx) store.set(null);
    };
  }, [store, ctx]);
}

/** Read the current page context once (snapshot at render time). */
export function useCurrentPageContext(): PageContext | null {
  const store = useContext(StoreContext);
  return store ? store.get() : null;
}

/**
 * Stable getter for the latest page context. Use this when you need to read
 * the value at an arbitrary later moment (e.g. inside a transport body
 * resolver) rather than at render time. Returns a function whose identity is
 * stable for the life of the provider.
 */
export function usePageContextGetter(): () => PageContext | null {
  const store = useContext(StoreContext);
  return store ? store.get : () => null;
}
