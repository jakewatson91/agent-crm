'use client';

import { useEffect, useState } from 'react';
import { ChainHops, type ChainResponse } from '../CiteChain';
import { Timestamp } from '../Timestamp';
import { useDrawer } from '../Drawer';
import { lowConfLabel } from '../../_lib/confidence';
import { humanizePredicate } from '../../_lib/labels';

interface DrawerFact {
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

export function FactDrawerBody({ factId }: { factId: string }) {
  const { push } = useDrawer();
  const [data, setData] = useState<(Omit<ChainResponse, 'fact'> & { fact: DrawerFact }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`/api/facts/${factId}/chain`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setError(j.error); else setData(j); })
      .catch((e) => setError(String(e)));
  }, [factId]);

  if (error) return <div style={{ color: 'var(--accent-coral)', fontSize: '.85rem' }}>✗ {error}</div>;
  if (!data) return <div className="subtle" style={{ fontSize: '.85rem' }}>loading…</div>;

  const f = data.fact;

  return (
    <div>
      <div className="subtle" style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.3rem' }}>
        fact
      </div>
      <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '.15rem' }}>{humanizePredicate(f.predicate)}</div>
      <div style={{ fontSize: '.92rem', color: 'var(--text)', marginBottom: '.4rem' }}>
        {f.object_entity && f.object_entity_name ? (
          <button onClick={() => push({ kind: 'entity', id: f.object_entity!, label: f.object_entity_name! })} style={linkBtn}>
            {f.object_entity_name}
          </button>
        ) : (f.object_text ?? '—')}
      </div>
      <div className="muted mono" style={{ fontSize: '.72rem', marginBottom: '.9rem' }}>
        {lowConfLabel(f.confidence) && <span style={{ color: 'var(--accent-coral)' }}>{lowConfLabel(f.confidence)} · </span>}
        <Timestamp value={f.observed_at} />
      </div>

      {f.subject_entity_name && (
        <button
          onClick={() => push({ kind: 'entity', id: f.subject_entity, label: f.subject_entity_name! })}
          className="chip"
          style={{ marginBottom: '1.25rem', cursor: 'pointer' }}
        >
          about {f.subject_entity_name} →
        </button>
      )}

      <div className="subtle" style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.6rem' }}>
        where this came from
      </div>
      <ChainHops hops={data.hops} />
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent-blue)', fontSize: 'inherit', textAlign: 'left',
};
