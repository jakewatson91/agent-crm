'use client';

/**
 * Entities index — pure client component.
 *
 * The previous SSR version paid for ~355 EntityCard renders × 1 `Timestamp`
 * client-component boundary each, which on warm hits cost 2-3s of RSC
 * serialization. Moving to client + SWR cuts that to a single client render,
 * cached across navigations. Data comes from /api/entities/index, which itself
 * caches the Supabase round-trips for 10s via unstable_cache.
 */

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';
import { Timestamp } from '../../../_components/Timestamp';
import { useSetPageContext, type PageContext } from '../../../_components/PageContext';

interface EntityRow {
  id: string;
  types: string[];
  name: string;
  attributes: Record<string, unknown>;
  updated_at: string;
}

// Primary type drives grouping + the "kind" badge. An entity with multiple
// is_a values appears in its first listed group; if it has no types, it goes
// under 'other'.
function primaryType(e: EntityRow): string {
  return e.types[0] ?? 'other';
}

interface Activity {
  ts: string;
  kind: string;
}

interface EntitiesPageData {
  entities: EntityRow[];
  icpEntries: Array<[string, number]>;
  lastActivityEntries: Array<[string, Activity]>;
}

// Display order for the legacy types. Anything the agent invents lands after
// these in the order it first appears.
const KIND_ORDER: string[] = ['account', 'contact', 'product'];

// Decision bands mirror the action_selector thresholds, so filtering here is
// auditing *what the agent decides to do*, not building a lead list.
type Band = 'all' | 'draft' | 'watch' | 'noaction' | 'drop' | 'unscored';
const BAND_LABEL: Record<Band, string> = {
  all: 'any score',
  draft: 'draft-ready (≥ 0.65)',
  watch: 'watching (0.5–0.65)',
  noaction: 'no action (0.35–0.5)',
  drop: 'dropped (< 0.35)',
  unscored: 'unscored',
};
function bandOf(icp: number | null): Exclude<Band, 'all'> {
  if (icp === null) return 'unscored';
  if (icp >= 0.65) return 'draft';
  if (icp >= 0.5) return 'watch';
  if (icp >= 0.35) return 'noaction';
  return 'drop';
}

type SortBy = 'activity' | 'icp' | 'name';

const ACTIVITY_VERB: Record<string, string> = {
  claim:        'extracted facts',
  decision:     'agent noted',
  touch_draft:  'drafted outreach',
  gate_request: 'queued for approval',
  outcome:      'recorded outcome',
  question:     'asked a question',
  system:       'system event',
};

export default function EntitiesIndexPage() {
  const params = useParams<{ ws: string }>();
  const ws = params?.ws as string;
  const { data, error } = useSWR<EntitiesPageData>(
    ws ? `/api/entities/index?workspace_id=${ws}` : null,
    DEFAULT_SWR,
  );

  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | string>('all');
  const [band, setBand] = useState<Band>('all');
  const [sortBy, setSortBy] = useState<SortBy>('activity');
  const controlsActive = query.trim() !== '' || kindFilter !== 'all' || band !== 'all' || sortBy !== 'activity';

  const pageCtx = useMemo<PageContext | null>(() => {
    if (!data) return null;
    const lastActivity = new Map(data.lastActivityEntries);
    const icp = new Map(data.icpEntries);
    const q = query.trim().toLowerCase();
    const ctrlActive = q !== '' || kindFilter !== 'all' || band !== 'all' || sortBy !== 'activity';

    let ordered: EntityRow[];
    let summary: string;
    if (ctrlActive) {
      // Reflect exactly what the user filtered/sorted to, so ⌘J chat acts on
      // the same set the user is looking at.
      ordered = data.entities
        .filter((e) => kindFilter === 'all' || e.types.includes(kindFilter))
        .filter((e) => band === 'all' || bandOf(icp.get(e.id) ?? null) === band)
        .filter((e) => q === '' || e.name.toLowerCase().includes(q));
      ordered.sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'icp') return (icp.get(b.id) ?? -1) - (icp.get(a.id) ?? -1);
        const aTs = lastActivity.get(a.id)?.ts ?? a.updated_at;
        const bTs = lastActivity.get(b.id)?.ts ?? b.updated_at;
        return Date.parse(bTs) - Date.parse(aTs);
      });
      const filters = [
        kindFilter !== 'all' && `kind=${kindFilter}`,
        band !== 'all' && `band=${band}`,
        q !== '' && `search="${q}"`,
        sortBy !== 'activity' && `sorted by ${sortBy}`,
      ].filter(Boolean).join(', ');
      summary = `${ordered.length} entities matching filters (${filters})`;
    } else {
      // Default audit view: grouped by primary type, most-recent activity first.
      const byKind = new Map<string, EntityRow[]>();
      for (const e of data.entities) {
        const k = primaryType(e);
        const arr = byKind.get(k) ?? [];
        arr.push(e);
        byKind.set(k, arr);
      }
      for (const arr of byKind.values()) {
        arr.sort((a, b) => {
          const aTs = lastActivity.get(a.id)?.ts ?? a.updated_at;
          const bTs = lastActivity.get(b.id)?.ts ?? b.updated_at;
          return Date.parse(bTs) - Date.parse(aTs);
        });
      }
      ordered = [];
      for (const k of KIND_ORDER) ordered.push(...(byKind.get(k) ?? []));
      for (const k of byKind.keys()) {
        if (!KIND_ORDER.includes(k)) ordered.push(...(byKind.get(k) ?? []));
      }
      summary = `${data.entities.length} entities, grouped by type (account, contact, product), sorted by most recent activity within each group`;
    }
    return {
      tab: 'entities',
      summary,
      visible: ordered.slice(0, 10).map((e) => ({
        kind: primaryType(e),
        id: e.id,
        label: e.name,
      })),
    };
  }, [data, query, kindFilter, band, sortBy]);
  useSetPageContext(pageCtx);

  if (!ws) return null;
  if (error) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Entities</h2>
        <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)', fontSize: '.85rem' }}>
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      </section>
    );
  }
  if (!data) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Entities</h2>
        <p className="subtle" style={{ fontSize: '.85rem' }}>loading…</p>
      </section>
    );
  }

  const entities = data.entities;
  const icpMap = new Map(data.icpEntries);
  const lastActivity = new Map(data.lastActivityEntries);

  const byKind = new Map<string, EntityRow[]>();
  for (const e of entities) {
    const k = primaryType(e);
    const arr = byKind.get(k) ?? [];
    arr.push(e);
    byKind.set(k, arr);
  }
  for (const arr of byKind.values()) {
    arr.sort((a, b) => {
      const aTs = lastActivity.get(a.id)?.ts ?? a.updated_at;
      const bTs = lastActivity.get(b.id)?.ts ?? b.updated_at;
      return Date.parse(bTs) - Date.parse(aTs);
    });
  }

  const orderedKinds: string[] = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)),
  ];

  // Flat filtered + sorted list, used only when a control is active. Default
  // (no controls touched) keeps the grouped-by-type audit view untouched.
  const q = query.trim().toLowerCase();
  const filtered = entities
    .filter((e) => kindFilter === 'all' || e.types.includes(kindFilter))
    .filter((e) => band === 'all' || bandOf(icpMap.get(e.id) ?? null) === band)
    .filter((e) => q === '' || e.name.toLowerCase().includes(q));
  filtered.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'icp') return (icpMap.get(b.id) ?? -1) - (icpMap.get(a.id) ?? -1);
    const aTs = lastActivity.get(a.id)?.ts ?? a.updated_at;
    const bTs = lastActivity.get(b.id)?.ts ?? b.updated_at;
    return Date.parse(bTs) - Date.parse(aTs);
  });

  return (
    <section>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Entities</h2>
        <div className="subtle" style={{ fontSize: '.85rem', marginTop: '.25rem' }}>
          Everything in this workspace, grouped by kind. {entities.length} total. Click in to walk an entity's timeline, or ⌘J on a page to ask the agent.
        </div>
      </div>

      <Controls
        query={query} setQuery={setQuery}
        kindFilter={kindFilter} setKindFilter={setKindFilter}
        kinds={orderedKinds}
        band={band} setBand={setBand}
        sortBy={sortBy} setSortBy={setSortBy}
      />

      {entities.length === 0 ? (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', fontSize: '.85rem' }}>
          No entities yet. The agent will create them as it processes signals.
        </div>
      ) : controlsActive ? (
        <div>
          <div className="subtle" style={{ fontSize: '.72rem', marginBottom: '.6rem' }}>
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}
          </div>
          {filtered.length === 0 ? (
            <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', fontSize: '.85rem' }}>
              Nothing matches these filters.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
              {filtered.map((e) => (
                <EntityCard
                  key={e.id}
                  entity={e}
                  ws={ws}
                  icp={icpMap.get(e.id) ?? null}
                  activity={lastActivity.get(e.id) ?? null}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        orderedKinds.map((kind) => (
          <KindSection
            key={kind}
            kind={kind}
            entities={byKind.get(kind) ?? []}
            ws={ws}
            icpMap={icpMap}
            lastActivity={lastActivity}
          />
        ))
      )}
    </section>
  );
}

function Controls({
  query, setQuery, kindFilter, setKindFilter, kinds, band, setBand, sortBy, setSortBy,
}: {
  query: string; setQuery: (v: string) => void;
  kindFilter: 'all' | string; setKindFilter: (v: 'all' | string) => void;
  kinds: string[];
  band: Band; setBand: (v: Band) => void;
  sortBy: SortBy; setSortBy: (v: SortBy) => void;
}) {
  const selStyle: React.CSSProperties = {
    fontSize: '.8rem', padding: '.35rem .5rem', borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)',
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center', marginBottom: '1.25rem' }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name…"
        style={{ ...selStyle, flex: '1 1 180px', minWidth: 140 }}
      />
      <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | string)} style={selStyle}>
        <option value="all">all types</option>
        {kinds.map((k) => <option key={k} value={k}>{k}s</option>)}
      </select>
      <select value={band} onChange={(e) => setBand(e.target.value as Band)} style={selStyle} title="Filter by the agent's decision band">
        {(Object.keys(BAND_LABEL) as Band[]).map((b) => <option key={b} value={b}>{BAND_LABEL[b]}</option>)}
      </select>
      <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} style={selStyle}>
        <option value="activity">recent activity</option>
        <option value="icp">icp fit</option>
        <option value="name">name</option>
      </select>
    </div>
  );
}

function KindSection({
  kind, entities, ws, icpMap, lastActivity,
}: {
  kind: string;
  entities: EntityRow[];
  ws: string;
  icpMap: Map<string, number>;
  lastActivity: Map<string, Activity>;
}) {
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <div
        className="subtle"
        style={{
          fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.08em',
          marginBottom: '.6rem',
        }}
      >
        {kind}s · {entities.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
        {entities.map((e) => (
          <EntityCard
            key={e.id}
            entity={e}
            ws={ws}
            icp={icpMap.get(e.id) ?? null}
            activity={lastActivity.get(e.id) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function fitColor(v: number | null): string {
  if (v === null) return 'var(--text-3)';
  if (v >= 0.7) return 'var(--accent-green)';
  if (v >= 0.5) return 'var(--accent-amber)';
  return 'var(--accent-coral)';
}

function EntityCard({
  entity, ws, icp, activity,
}: {
  entity: EntityRow;
  ws: string;
  icp: number | null;
  activity: Activity | null;
}) {
  const oneLiner = describeEntity(entity, activity);
  const type = primaryType(entity);

  const card = (
    <div
      className="card"
      style={{
        padding: '.65rem .9rem',
        display: 'flex',
        alignItems: 'center',
        gap: '.7rem',
        cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '.95rem', fontWeight: 500, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          {entity.name}
          {type && <span className="badge badge-mute" style={{ fontSize: '.65rem', textTransform: 'lowercase' }}>{type}</span>}
        </div>
        <div className="subtle" style={{ fontSize: '.75rem', marginTop: 2 }}>
          {oneLiner}
        </div>
      </div>
      {icp !== null && (
        <span
          className="mono"
          style={{
            fontSize: '.72rem',
            color: fitColor(icp),
            padding: '1px 6px',
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            whiteSpace: 'nowrap',
          }}
          title="ICP fit"
        >
          icp {icp.toFixed(2)}
        </span>
      )}
    </div>
  );

  return (
    <Link href={`/workspace/${ws}/entities/${entity.id}`} style={{ textDecoration: 'none' }}>
      {card}
    </Link>
  );
}

function describeEntity(e: EntityRow, activity: Activity | null): React.ReactNode {
  if (e.types.includes('account')) {
    if (activity) {
      const verb = ACTIVITY_VERB[activity.kind] ?? activity.kind;
      return (
        <>
          {verb} · <Timestamp value={activity.ts} />
        </>
      );
    }
    return <>no agent activity yet · created <Timestamp value={e.updated_at} /></>;
  }

  if (e.types.includes('contact')) {
    const company = (e.attributes?.['company'] as string | undefined) ?? (e.attributes?.['account'] as string | undefined);
    const title = (e.attributes?.['title'] as string | undefined) ?? (e.attributes?.['seniority'] as string | undefined);
    const bits = [company && `at ${company}`, title].filter(Boolean) as string[];
    if (bits.length) return <>{bits.join(' · ')} · updated <Timestamp value={e.updated_at} /></>;
    return <>updated <Timestamp value={e.updated_at} /></>;
  }

  if (e.types.includes('product')) {
    const version = (e.attributes?.['version'] as string | undefined);
    const pricing = (e.attributes?.['pricing'] as string | undefined) ?? (e.attributes?.['price'] as string | undefined);
    const bits = [version && `v${version}`, pricing].filter(Boolean) as string[];
    if (bits.length) return <>{bits.join(' · ')} · updated <Timestamp value={e.updated_at} /></>;
    return <>updated <Timestamp value={e.updated_at} /></>;
  }

  return <>updated <Timestamp value={e.updated_at} /></>;
}
