'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

export default function ReplayPage() {
  const params = useParams<{ ws: string }>();
  // Initialize empty so server and client agree on the SSR pass; populate after mount.
  const [ts, setTs] = useState<string>('');
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  async function load(atTs: string) {
    if (!atTs) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/primitives/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws, ts: atTs }),
      });
      setSnapshot(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = new Date().toISOString();
    setTs(initial);
    load(initial);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Replay</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>
        Reconstruct workspace state at any point in the past from the event log.
      </p>
      <input
        type="datetime-local"
        value={ts.slice(0, 16)}
        onChange={(e) => setTs(new Date(e.target.value).toISOString())}
        style={{ background: '#0a0a0a', color: '#e5e5e5', border: '1px solid #1f1f1f', padding: '.5rem', marginRight: '.5rem' }}
      />
      <button onClick={() => load(ts)} disabled={loading} style={{ padding: '.5rem 1rem', background: '#7aa2f7', color: '#000', border: 'none', cursor: 'pointer' }}>
        {loading ? 'replaying…' : 'replay to ts'}
      </button>
      {snapshot !== null && (
        <pre style={{ marginTop: '1.5rem', padding: '1rem', background: '#111', overflowX: 'auto', fontSize: '.75rem' }}>
          {JSON.stringify(snapshot, null, 2)}
        </pre>
      )}
    </section>
  );
}
