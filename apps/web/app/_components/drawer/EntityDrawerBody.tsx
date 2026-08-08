'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDrawer } from '../Drawer';
import { AttributeGrid } from '../../workspace/[ws]/entities/[entity_id]/AttributeGrid';
import { humanizePredicate } from '../../_lib/labels';
import { groupVisibleFacts, buildScoreCard, predicateLabel, FAMILY_LABEL, type FactLike } from '../../_lib/facts_view';
import { bandOf, bandColor, BAND_HEADLINE, BAND_VERDICT } from '../../_lib/bands';
import { lowConfLabel } from '../../_lib/confidence';
import { Timestamp } from '../Timestamp';

interface EntityInfo {
  id: string;
  name: string;
  kind: string;
  attributes: Record<string, unknown>;
}

interface RelatedEntity {
  entity_id: string;
  name: string;
  kind: string;
  via_predicate: string;
  via_fact_id: string;
  confidence: number;
}

const MAX_RELATED = 8;

export function EntityDrawerBody({ ws, entityId }: { ws: string; entityId: string }) {
  const { push } = useDrawer();
  const [entity, setEntity] = useState<EntityInfo | null>(null);
  const [grouped, setGrouped] = useState<Record<string, FactLike[]> | null>(null);
  const [related, setRelated] = useState<{ inbound: RelatedEntity[]; outbound: RelatedEntity[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntity(null);
    setGrouped(null);
    setRelated(null);
    setError(null);
    fetch(`/api/entities/${entityId}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setError(j.error); else setEntity(j); })
      .catch((e) => setError(String(e)));
    fetch(`/api/entities/${entityId}/facts`)
      .then((r) => r.json())
      .then((j) => setGrouped(j.grouped ?? {}))
      .catch(() => setGrouped({}));
    fetch(`/api/entities/${entityId}/related`)
      .then((r) => r.json())
      .then((j) => setRelated(j))
      .catch(() => setRelated({ inbound: [], outbound: [] }));
  }, [entityId]);

  if (error) return <div style={{ color: 'var(--accent-coral)', fontSize: '.85rem' }}>✗ {error}</div>;
  if (!entity) return <div className="subtle" style={{ fontSize: '.85rem' }}>loading…</div>;

  const { visibleFacts, families } = groupVisibleFacts(grouped ?? {});
  const { score, scoreReasoning } = buildScoreCard(grouped ?? {});
  const neighbors = related
    ? [...related.inbound, ...related.outbound].sort((a, b) => b.confidence - a.confidence)
    : [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.5rem', marginBottom: '.75rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
          {entity.name} <span className="badge badge-mute" style={{ marginLeft: '.4rem', fontSize: '.62rem' }}>{entity.kind}</span>
        </h3>
      </div>

      <Link href={`/workspace/${ws}/entities/${entity.id}`} style={{ fontSize: '.78rem' }}>
        Open full page →
      </Link>

      <AttributeGrid attributes={entity.attributes} />

      {score !== null && (
        <div className="card" style={{ marginTop: '1rem', padding: '.7rem .8rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '.88rem', fontWeight: 600, color: bandColor(score) }}>{BAND_HEADLINE[bandOf(score)]}</div>
            <div className="subtle mono" style={{ fontSize: '.74rem' }}>{Math.round(score * 100)}% match</div>
          </div>
          <div className="subtle" style={{ fontSize: '.76rem', marginTop: '.25rem', color: 'var(--text-2)' }}>
            {BAND_VERDICT[bandOf(score)]}
          </div>
          {scoreReasoning && (
            <div style={{ fontSize: '.78rem', marginTop: '.4rem', lineHeight: 1.45, color: 'var(--text)' }}>{scoreReasoning}</div>
          )}
        </div>
      )}

      {neighbors.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.5rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            connections · {neighbors.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
            {neighbors.slice(0, MAX_RELATED).map((n) => (
              <div key={n.entity_id + n.via_fact_id} style={{ fontSize: '.8rem', display: 'flex', gap: '.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="subtle">{predicateLabel(n.via_predicate)} →</span>
                <button onClick={() => push({ kind: 'entity', id: n.entity_id, label: n.name })} style={linkBtn}>{n.name}</button>
              </div>
            ))}
            {neighbors.length > MAX_RELATED && (
              <div className="muted" style={{ fontSize: '.72rem' }}>+{neighbors.length - MAX_RELATED} more — see full page</div>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: '1.25rem' }}>
        <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.5rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          current facts
        </div>
        {families.length === 0 ? (
          <div className="muted" style={{ fontSize: '.8rem' }}>No facts asserted yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.65rem' }}>
            {families.map((fam) => (
              <div key={fam}>
                <div className="subtle" style={{ fontSize: '.66rem', marginBottom: '.3rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  {FAMILY_LABEL[fam] ?? fam}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
                  {(visibleFacts[fam] ?? []).map((f) => (
                    <div key={f.id} style={{ fontSize: '.78rem' }}>
                      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'baseline', justifyContent: 'space-between' }}>
                        <span className="subtle" style={{ color: 'var(--text-2)' }}>{humanizePredicate(f.predicate)}</span>
                        <button
                          onClick={() => push({ kind: 'fact', id: f.id, label: humanizePredicate(f.predicate) })}
                          style={{ ...linkBtn, fontSize: '.68rem', flexShrink: 0 }}
                        >
                          trace
                        </button>
                      </div>
                      <div>
                        {f.object_entity && f.object_entity_name ? (
                          <button onClick={() => push({ kind: 'entity', id: f.object_entity!, label: f.object_entity_name! })} style={linkBtn}>
                            {f.object_entity_name}
                          </button>
                        ) : (
                          <span>{f.object_text ?? '—'}</span>
                        )}
                        {lowConfLabel(f.confidence) && (
                          <span style={{ color: 'var(--accent-coral)', fontSize: '.68rem', marginLeft: '.4rem' }}>{lowConfLabel(f.confidence)}</span>
                        )}
                      </div>
                      <div className="muted mono" style={{ fontSize: '.66rem' }}><Timestamp value={f.observed_at} /></div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent-blue)', fontSize: 'inherit', textAlign: 'left',
};
