'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';

export default function QueryPage() {
  const params = useParams<{ ws: string }>();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const res = await fetch(`/api/primitives/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws, nl: q }),
      });
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Query</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>
        Ad-hoc pull. Use only when you want to know something the system hasn&apos;t already surfaced.
      </p>
      <textarea
        value={q}
        onChange={(e) => setQ(e.target.value)}
        rows={3}
        placeholder="ask anything…"
        style={{
          width: '100%', padding: '.75rem', background: '#0a0a0a', color: '#e5e5e5',
          border: '1px solid #1f1f1f', fontFamily: 'inherit', marginTop: '1rem',
        }}
      />
      <button
        onClick={run}
        disabled={loading || !q.trim()}
        style={{ marginTop: '.75rem', padding: '.5rem 1rem', background: '#7aa2f7', color: '#000', border: 'none', cursor: 'pointer' }}
      >
        {loading ? 'thinking…' : 'ask'}
      </button>
      {result !== null && (
        <pre style={{ marginTop: '1.5rem', padding: '1rem', background: '#111', overflowX: 'auto', fontSize: '.8rem' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}
