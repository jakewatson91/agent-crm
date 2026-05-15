'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Match {
  entity_id: string;
  name: string;
  kind: string;
  channel_id: string | null;
  icp_fit: number | null;
}

function fitColor(v: number | null): string {
  if (v === null) return 'var(--text-3)';
  if (v >= 0.7) return 'var(--accent-green)';
  if (v >= 0.5) return 'var(--accent-amber)';
  return 'var(--accent-coral)';
}

/**
 * Sidebar search-and-jump. Fuzzy-matches entity name within the workspace and
 * lets you navigate to the per-entity timeline. ⌘K / Ctrl+K focuses the input
 * because you'll use this constantly when reviewing what the agent did about
 * a specific account.
 */
export function EntitySearch({ ws }: { ws: string }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);     // highlighted index
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K focuses, Esc clears.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Debounced fetch.
  useEffect(() => {
    if (!q.trim()) { setMatches([]); return; }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const r = await fetch(`/api/entities/lookup?workspace_id=${ws}&q=${encodeURIComponent(q)}`);
        const j = await r.json();
        setMatches((j.matches ?? []) as Match[]);
        setHi(0);
      } catch { /* leave previous matches */ }
      finally { setLoading(false); }
    }, 150);
    return () => clearTimeout(handle);
  }, [q, ws]);

  function navigateTo(m: Match) {
    if (m.channel_id) router.push(`/workspace/${ws}/channels/${m.channel_id}`);
    setOpen(false);
    setQ('');
  }

  function onKeyDownInput(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[hi];
      if (m) navigateTo(m);
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', marginBottom: '1rem' }}>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDownInput}
          placeholder="Find an entity"
          style={{
            width: '100%',
            background: 'var(--panel-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '.45rem .65rem',
            paddingRight: '2.4rem',
            fontFamily: 'inherit',
            fontSize: '.85rem',
            outline: 'none',
          }}
        />
        <span
          className="mono"
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '.65rem',
            color: 'var(--text-3)',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 5px',
            pointerEvents: 'none',
          }}
          title="Focus shortcut"
        >
          ⌘K
        </span>
      </div>
      {open && q.trim() && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
            zIndex: 50,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {loading && matches.length === 0 && (
            <div className="subtle" style={{ padding: '.5rem .65rem', fontSize: '.78rem' }}>searching…</div>
          )}
          {!loading && matches.length === 0 && (
            <div className="muted" style={{ padding: '.5rem .65rem', fontSize: '.78rem' }}>no matches</div>
          )}
          {matches.map((m, i) => {
            const active = i === hi;
            return (
              <button
                key={m.entity_id}
                onMouseEnter={() => setHi(i)}
                onClick={() => navigateTo(m)}
                disabled={!m.channel_id}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'baseline',
                  gap: '.55rem',
                  padding: '.45rem .65rem',
                  background: active ? 'var(--panel-2)' : 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  cursor: m.channel_id ? 'pointer' : 'not-allowed',
                  opacity: m.channel_id ? 1 : 0.5,
                }}
              >
                <span style={{ fontWeight: 500, color: 'var(--text)', fontSize: '.86rem' }}>{m.name}</span>
                <span className="mono subtle" style={{ fontSize: '.7rem' }}>{m.kind}</span>
                {m.icp_fit !== null && (
                  <span
                    className="mono"
                    style={{
                      marginLeft: 'auto',
                      fontSize: '.7rem',
                      color: fitColor(m.icp_fit),
                      padding: '1px 6px',
                      background: 'var(--panel-2)',
                      borderRadius: 4,
                    }}
                  >
                    {m.icp_fit.toFixed(2)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
