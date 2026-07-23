'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Candidate {
  entity_id: string;
  name: string;
  domain: string | null;
  reason: 'domain' | 'name' | 'name_token';
  similarity: number;
}

interface Props {
  ws: string;
  entityId: string;
  entityName: string;
  candidates: Candidate[];
}

const REASON_LABEL: Record<Candidate['reason'], string> = {
  domain: 'same website',
  name: 'similar name',
  name_token: 'shared name',
};

const PILL: React.CSSProperties = {
  padding: '.3rem .7rem', fontSize: '.78rem', border: 'none',
  cursor: 'pointer', borderRadius: 4, fontWeight: 500,
};

// Detected duplicate accounts. The pipeline never merges on its own — it surfaces the
// proposal here and the human approves or rejects. Merge folds the candidate INTO the
// account being viewed (the one you're on stays; the duplicate is archived).
export function MergeProposal({ ws, entityId, entityName, candidates }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(candidates);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!rows.length) return null;

  async function act(candidate: Candidate, action: 'merge' | 'dismiss') {
    setBusy(candidate.entity_id);
    setError(null);
    try {
      const res = await fetch('/api/entities/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws, action, canonical_id: entityId, duplicate_id: candidate.entity_id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'request failed');
      if (action === 'merge') router.refresh();
      else setRows((r) => r.filter((x) => x.entity_id !== candidate.entity_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      style={{
        border: '1px solid var(--warn-border, #e0c060)',
        background: 'var(--warn-bg, rgba(224,192,96,.08))',
        borderRadius: 8, padding: '.85rem 1rem', marginBottom: '1rem',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.5rem' }}>
        Possible duplicate account{rows.length > 1 ? 's' : ''}
      </div>
      <div className="subtle" style={{ fontSize: '.82rem', marginBottom: '.6rem' }}>
        These look like the same account as <strong>{entityName}</strong>. Merging folds the other
        one into this account and archives it; nothing is deleted. If they are different companies, dismiss.
      </div>
      {rows.map((c) => (
        <div
          key={c.entity_id}
          style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.35rem 0', flexWrap: 'wrap' }}
        >
          <span style={{ fontSize: '.85rem' }}>
            <strong>{c.name}</strong>
            {c.domain ? <span className="subtle"> · {c.domain}</span> : null}
            <span className="subtle"> · {REASON_LABEL[c.reason]}</span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            style={{ ...PILL, background: 'var(--accent, #2563eb)', color: '#fff', opacity: busy ? 0.6 : 1 }}
            disabled={!!busy}
            onClick={() => act(c, 'merge')}
          >
            {busy === c.entity_id ? '…' : `Merge into ${entityName}`}
          </button>
          <button
            style={{ ...PILL, background: 'transparent', border: '1px solid var(--border, #ccc)', opacity: busy ? 0.6 : 1 }}
            disabled={!!busy}
            onClick={() => act(c, 'dismiss')}
          >
            Not the same
          </button>
        </div>
      ))}
      {error ? <div style={{ color: 'crimson', fontSize: '.8rem', marginTop: '.4rem' }}>{error}</div> : null}
    </section>
  );
}
