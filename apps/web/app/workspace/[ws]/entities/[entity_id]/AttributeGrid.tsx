import { Fragment } from 'react';
import { Timestamp } from '../../../../_components/Timestamp';
import { humanizeKey, isMachineAttribute } from '../../../../_lib/labels';

/**
 * Renders entities.attributes as a readable key/value grid instead of a raw
 * JSON dump. Presentation only — no data-shape assumptions beyond "it's a
 * plain object".
 *
 * The visible grid shows only what a human can act on. Machine codes — bare
 * UUIDs, hashes, id fields, and underscore-prefixed audit metadata — are kept
 * out of the grid but stay one click away in the raw JSON toggle (and in the
 * API the agent reads).
 */

// Keys whose string values should render as outbound links.
const LINK_KEYS = new Set([
  'domain', 'website', 'url', 'homepage', 'site',
  'linkedin', 'linkedin_url', 'twitter', 'github', 'crunchbase',
]);

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(s) && !Number.isNaN(Date.parse(s));
}

// Returns an href if this value should link out, else null.
function toHref(key: string, value: string): string | null {
  if (/^https?:\/\//i.test(value)) return value;
  if (LINK_KEYS.has(key.toLowerCase())) {
    // bare domain like "apollo.io" or "apollo.io/team"
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) return `https://${value}`;
  }
  return null;
}

function AttrValue({ k, value }: { k: string; value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span className="muted">—</span>;
  }
  if (typeof value === 'boolean') return <span>{value ? 'yes' : 'no'}</span>;
  if (typeof value === 'number') return <span className="mono">{value}</span>;

  if (typeof value === 'string') {
    const href = toHref(k, value);
    if (href) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-blue)', textDecoration: 'none', overflowWrap: 'anywhere' }}>
          {value}
        </a>
      );
    }
    if (isIsoDate(value)) return <Timestamp value={value} />;
    return <span style={{ overflowWrap: 'anywhere' }}>{value}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">—</span>;
    return (
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem' }}>
        {value.map((v, i) =>
          v !== null && typeof v === 'object'
            ? <code key={i} className="mono" style={{ fontSize: '.7rem' }}>{JSON.stringify(v)}</code>
            : <span key={i} className="badge badge-mute" style={{ fontSize: '.68rem' }}>{String(v)}</span>,
        )}
      </span>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="muted">—</span>;
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: '.15rem' }}>
        {entries.map(([nk, nv]) => (
          <span key={nk} className="mono" style={{ fontSize: '.72rem', overflowWrap: 'anywhere' }}>
            <span style={{ color: 'var(--text-3)' }}>{nk}:</span>{' '}
            {nv !== null && typeof nv === 'object' ? JSON.stringify(nv) : String(nv)}
          </span>
        ))}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

export function AttributeGrid({ attributes }: { attributes: Record<string, unknown> }) {
  const keys = Object.keys(attributes ?? {});
  if (keys.length === 0) return null;

  // Show only human-readable attributes. Internal `_` keys, machine codes
  // (ids, hashes, UUIDs, scheme ids, code arrays) and nested metadata objects
  // drop out of the grid — they're still in the raw JSON toggle below.
  const ordered = keys
    .filter((k) => !isMachineAttribute(k, attributes[k]))
    .sort();

  return (
    <div className="card" style={{ marginTop: '1rem', padding: '.7rem .9rem' }}>
      <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.55rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        attributes
      </div>
      {ordered.length === 0 ? (
        <div className="muted" style={{ fontSize: '.78rem' }}>Nothing human-readable here yet — see raw JSON.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', columnGap: '1rem', rowGap: '.4rem', alignItems: 'baseline' }}>
          {ordered.map((k) => (
            <Fragment key={k}>
              <div className="subtle" style={{ fontSize: '.74rem', color: 'var(--text-2)', overflowWrap: 'anywhere' }}>
                {humanizeKey(k)}
              </div>
              <div style={{ fontSize: '.8rem', color: 'var(--text)', minWidth: 0 }}>
                <AttrValue k={k} value={attributes[k]} />
              </div>
            </Fragment>
          ))}
        </div>
      )}
      <details style={{ marginTop: '.65rem' }}>
        <summary className="subtle" style={{ cursor: 'pointer', fontSize: '.7rem' }}>raw JSON</summary>
        <pre className="mono subtle" style={{ margin: '.4rem 0 0', fontSize: '.72rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {JSON.stringify(attributes, null, 2)}
        </pre>
      </details>
    </div>
  );
}
