'use client';

import { useEffect, useState } from 'react';
import { useDrawer } from '../Drawer';
import { humanizePredicate } from '../../_lib/labels';
import { Timestamp } from '../Timestamp';

interface SignalFact {
  id: string;
  subject_entity: string;
  subject_entity_name: string | null;
  predicate: string;
  object_text: string | null;
  object_entity: string | null;
  object_entity_name: string | null;
  confidence: number;
  observed_at: string;
}

/**
 * The facts one signal (a page the agent read) produced. Answers "what did
 * this page actually teach the agent" — click a row to walk that fact's full
 * provenance trail.
 */
export function SignalFactsDrawerBody({ signalId }: { signalId: string }) {
  const { push } = useDrawer();
  const [facts, setFacts] = useState<SignalFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFacts(null);
    setError(null);
    fetch(`/api/signals/${signalId}/facts`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setError(j.error); else setFacts(j.facts ?? []); })
      .catch((e) => setError(String(e)));
  }, [signalId]);

  if (error) return <div style={{ color: 'var(--accent-coral)', fontSize: '.85rem' }}>✗ {error}</div>;
  if (!facts) return <div className="subtle" style={{ fontSize: '.85rem' }}>loading…</div>;

  return (
    <div>
      <div className="subtle" style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.6rem' }}>
        facts from this page · {facts.length}
      </div>
      {facts.length === 0 ? (
        <div className="muted" style={{ fontSize: '.8rem' }}>No facts recorded for this signal.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          {facts.map((f) => (
            <button
              key={f.id}
              onClick={() => push({ kind: 'fact', id: f.id, label: humanizePredicate(f.predicate) })}
              className="card"
              style={row}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.5rem' }}>
                <span className="subtle" style={{ fontSize: '.72rem', color: 'var(--text-2)' }}>
                  {f.subject_entity_name ?? 'entity'} · {humanizePredicate(f.predicate)}
                </span>
                <span className="muted mono" style={{ fontSize: '.66rem', whiteSpace: 'nowrap' }}><Timestamp value={f.observed_at} /></span>
              </div>
              <div style={{ fontSize: '.82rem', color: 'var(--text)', marginTop: '.15rem' }}>
                {f.object_entity_name ?? f.object_text ?? '—'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const row: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '.6rem .75rem',
  cursor: 'pointer', background: 'var(--panel)', border: '1px solid var(--border)',
};
