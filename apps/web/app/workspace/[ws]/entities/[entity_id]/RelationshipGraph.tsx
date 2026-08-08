'use client';

/**
 * The account's one-hop neighborhood: its people and related companies, each
 * row labeled with the relationship and linked back to the fact that
 * asserted it. Click any name to open it in the drawer — the "walk the
 * graph" move, without leaving the page it's on.
 */
import { CiteChain } from '../../../../_components/CiteChain';
import { EntityLink } from '../../../../_components/drawer/EntityLink';

export interface GraphNeighbor {
  entity_id: string;
  name: string;
  kind: string;
  rel: string; // human relationship label ("works at", "invested in", …)
  confidence: number;
  via_fact_id: string;
}

const MAX_SHOWN = 10;

export function RelationshipGraph({
  neighbors,
}: {
  centerName: string;
  centerKind: string;
  neighbors: GraphNeighbor[];
}) {
  const shown = neighbors.slice(0, MAX_SHOWN);
  const extra = neighbors.length - shown.length;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {shown.map((n) => (
        <div key={n.entity_id} className="list-row" style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap', padding: '.55rem .85rem' }}>
          <span className="subtle" style={{ fontSize: '.82rem' }}>{n.rel}</span>
          <EntityLink id={n.entity_id} label={n.name} style={{ fontSize: '.85rem', fontWeight: 500, color: 'var(--text)' }}>
            {n.name}
          </EntityLink>
          <span className="badge badge-mute">{n.kind}</span>
          <span style={{ marginLeft: 'auto' }}>
            <CiteChain fact_id={n.via_fact_id} label="trace" />
          </span>
        </div>
      ))}
      {extra > 0 && (
        <div className="muted" style={{ fontSize: '.74rem', padding: '.5rem .85rem' }}>
          +{extra} more connection{extra === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
