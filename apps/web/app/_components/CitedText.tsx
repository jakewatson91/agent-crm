'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Renders draft text with inline citation highlighting. When the drafter
 * supplied a cite_quotes anchor for a fact (the exact phrase it used, given
 * at generation time), we match that phrase directly. For posts written
 * before cite_quotes existed (or citations without one), we fall back to
 * guessing: searching for a verbatim substring of the fact's raw object_text
 * in the body. The guess is unreliable — the drafter almost always
 * paraphrases object_text into readable copy — which is why cite_quotes is
 * the primary path now, not the fallback.
 *
 * Either way, the "why this?" panel remains the complete, guaranteed list of
 * sources — this just surfaces the obvious anchors right in the text.
 */
interface Fact {
  id: string;
  predicate: string;
  object_text: string | null;
  confidence: number;
  source_signal: { source_name: string | null; source_url: string | null } | null;
}

export interface CiteQuote { fact_id: string; quote: string }

interface Span { start: number; end: number; fact: Fact }

// Longest contiguous word-window (>=3 words, >=10 chars) of a fact's text that
// appears verbatim (case-insensitive) in the body. Non-overlapping; longer wins.
function findSpans(text: string, facts: Fact[], citeQuotes: CiteQuote[]): Span[] {
  const lower = text.toLowerCase();
  const quoteByFactId = new Map(citeQuotes.map((cq) => [cq.fact_id, cq.quote]));
  const found: Span[] = [];
  for (const f of facts) {
    const quote = quoteByFactId.get(f.id)?.trim();
    if (quote) {
      const idx = lower.indexOf(quote.toLowerCase());
      if (idx >= 0) { found.push({ start: idx, end: idx + quote.length, fact: f }); continue; }
    }
    const ot = (f.object_text ?? '').trim();
    if (ot.length < 6) continue;
    const words = ot.split(/\s+/).filter(Boolean);
    let best: { start: number; end: number; len: number } | null = null;
    for (let size = words.length; size >= Math.min(3, words.length); size--) {
      for (let i = 0; i + size <= words.length; i++) {
        const phrase = words.slice(i, i + size).join(' ');
        if (phrase.length < 10) continue;
        const idx = lower.indexOf(phrase.toLowerCase());
        if (idx >= 0 && (!best || phrase.length > best.len)) {
          best = { start: idx, end: idx + phrase.length, len: phrase.length };
        }
      }
      if (best) break; // take the longest window size that hits anywhere
    }
    if (best) found.push({ start: best.start, end: best.end, fact: f });
  }
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Span[] = [];
  let lastEnd = -1;
  for (const s of found) if (s.start >= lastEnd) { out.push(s); lastEnd = s.end; }
  return out;
}

export function CitedText({ text, cites, citeQuotes = [] }: { text: string; cites: string[]; citeQuotes?: CiteQuote[] }) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function openHover(id: string) {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setHovered(id);
  }
  function scheduleClose(id: string) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered((h) => (h === id ? null : h)), 150);
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  useEffect(() => {
    if (cites.length === 0) return;
    let alive = true;
    fetch(`/api/facts/batch?ids=${cites.join(',')}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setFacts((j.facts ?? []) as Fact[]); })
      .catch(() => { /* highlighting is non-essential — fall back to plain text */ });
    return () => { alive = false; };
  }, [cites]);

  const spans = useMemo(() => (facts ? findSpans(text, facts, citeQuotes) : []), [facts, text, citeQuotes]);

  if (spans.length === 0) return <>{text}</>;

  // Stitch the text together: plain runs interleaved with highlighted spans.
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    if (s.start > cursor) parts.push(text.slice(cursor, s.start));
    const f = s.fact;
    const src = f.source_signal;
    parts.push(
      <span
        key={`s${i}`}
        style={{ position: 'relative', display: 'inline' }}
        onMouseEnter={() => openHover(`${i}`)}
        onMouseLeave={() => scheduleClose(`${i}`)}
      >
        <mark style={{
          background: 'var(--accent-blue-soft)', color: 'inherit',
          borderBottom: '1px dotted var(--badge-blue-fg)', borderRadius: 2, padding: '0 1px', cursor: 'help',
        }}>
          {text.slice(s.start, s.end)}
        </mark>
        {hovered === `${i}` && (
          <span
            onMouseEnter={() => openHover(`${i}`)}
            onMouseLeave={() => scheduleClose(`${i}`)}
            style={{
              position: 'absolute', left: 0, top: '100%', zIndex: 20, marginTop: 4,
              width: 320, padding: '.5rem .6rem', background: 'var(--panel-2)',
              border: '1px solid var(--border)', borderLeft: '3px solid var(--accent-blue)',
              borderRadius: 6, fontSize: '.74rem', lineHeight: 1.45,
              fontFamily: 'var(--font-sans)', whiteSpace: 'normal',
              boxShadow: '0 4px 14px rgba(0,0,0,.18)',
            }}>
            <span className="mono" style={{ color: 'var(--badge-blue-fg)', fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              cited fact
            </span>
            <span style={{ display: 'block', color: 'var(--text)', marginTop: '.25rem' }}>
              <span className="mono" style={{ color: 'var(--badge-green-fg)' }}>{f.predicate}</span> = {f.object_text ?? '—'}
            </span>
            <span className="mono subtle" style={{ display: 'block', marginTop: '.3rem', fontSize: '.68rem' }}>
              {src?.source_name ? <>via {src.source_name}</> : <>conf {f.confidence.toFixed(2)}</>}
              {src?.source_url && (
                <> · <a href={src.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-blue)' }}>open source ↗</a></>
              )}
            </span>
          </span>
        )}
      </span>,
    );
    cursor = s.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
}
