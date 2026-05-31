'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Renders draft text with best-effort inline citation highlighting. For each
 * fact the drafter cited, we try to find where its wording landed in the body
 * (deterministic substring match — NO LLM) and underline that span; hovering
 * shows the fact it came from and the source link.
 *
 * This is intentionally best-effort: the drafter emits one flat cite list for
 * the whole draft, not per-phrase anchors, so paraphrased claims won't match.
 * The "why this?" panel remains the complete, guaranteed list of sources — this
 * just surfaces the obvious anchors right in the text.
 */
interface Fact {
  id: string;
  predicate: string;
  object_text: string | null;
  confidence: number;
  source_signal: { source_name: string | null; source_url: string | null } | null;
}

interface Span { start: number; end: number; fact: Fact }

// Longest contiguous word-window (>=3 words, >=10 chars) of a fact's text that
// appears verbatim (case-insensitive) in the body. Non-overlapping; longer wins.
function findSpans(text: string, facts: Fact[]): Span[] {
  const lower = text.toLowerCase();
  const found: Span[] = [];
  for (const f of facts) {
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

export function CitedText({ text, cites }: { text: string; cites: string[] }) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (cites.length === 0) return;
    let alive = true;
    fetch(`/api/facts/batch?ids=${cites.join(',')}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setFacts((j.facts ?? []) as Fact[]); })
      .catch(() => { /* highlighting is non-essential — fall back to plain text */ });
    return () => { alive = false; };
  }, [cites]);

  const spans = useMemo(() => (facts ? findSpans(text, facts) : []), [facts, text]);

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
        onMouseEnter={() => setHovered(`${i}`)}
        onMouseLeave={() => setHovered((h) => (h === `${i}` ? null : h))}
      >
        <mark style={{
          background: 'var(--accent-blue-soft)', color: 'inherit',
          borderBottom: '1px dotted #4f6da3', borderRadius: 2, padding: '0 1px', cursor: 'help',
        }}>
          {text.slice(s.start, s.end)}
        </mark>
        {hovered === `${i}` && (
          <span style={{
            position: 'absolute', left: 0, top: '100%', zIndex: 20, marginTop: 4,
            width: 320, padding: '.5rem .6rem', background: 'var(--panel-2)',
            border: '1px solid var(--border)', borderLeft: '3px solid var(--accent-blue)',
            borderRadius: 6, fontSize: '.74rem', lineHeight: 1.45,
            fontFamily: 'var(--font-sans)', whiteSpace: 'normal',
            boxShadow: '0 4px 14px rgba(0,0,0,.18)',
          }}>
            <span className="mono" style={{ color: '#4f6da3', fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              cited fact
            </span>
            <span style={{ display: 'block', color: 'var(--text)', marginTop: '.25rem' }}>
              <span className="mono" style={{ color: '#5a7e5f' }}>{f.predicate}</span> = {f.object_text ?? '—'}
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
