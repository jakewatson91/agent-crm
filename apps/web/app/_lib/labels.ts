/**
 * Shared label + code helpers for the human-facing surfaces.
 *
 * The UI's job for a human is to explain *why* things happened in plain words.
 * Machine codes (ids, hashes, event numbers) don't help a person, so we hide
 * them from the default view and humanize field names instead. These helpers
 * are the single source of truth, so the attributes grid, the facts panel, and
 * the provenance walk all agree on what counts as a code and how a label reads.
 */

// Generic acronyms kept uppercase after humanizing. Shape only — these are
// common business/tech abbreviations, NOT vertical or brand-specific values.
const ACRONYMS = new Set([
  'id', 'url', 'uri', 'api', 'ai', 'ml', 'ui', 'ux',
  'ceo', 'cto', 'cfo', 'coo', 'cmo', 'vp', 'hr',
  'icp', 'crm', 'arr', 'mrr', 'ltv', 'cac', 'kpi', 'roi', 'tam',
  'b2b', 'b2c', 'saas', 'seo', 'sdr', 'ae',
  'us', 'uk', 'eu', 'usa', 'hq', 'faq',
]);

/** snake_case / camelCase field name → human Title Case label. */
export function humanizeKey(k: string): string {
  const cleaned = k
    .replace(/^_+/, '') // drop leading underscores
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2') // camelCase → spaced
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return k;
  return cleaned
    .split(' ')
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// A fact's field name reads the same way as an attribute key.
export const humanizePredicate = humanizeKey;

/**
 * Agent posts sometimes start with a machine action tag, e.g.
 * "[deep_research] …" or "[enrich_contacts] …". Split that leading tag off so
 * the UI shows the sentence in plain words and can render the tag as a small
 * humanized label instead of leaving the raw code in the text.
 */
export function stripActionTag(body: string): { tag: string | null; rest: string } {
  const m = body.match(/^\s*\[([^\]]+)\]\s*/);
  if (!m) return { tag: null, rest: body };
  return { tag: m[1] ?? null, rest: body.slice(m[0].length) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{24,}$/i;
// Scheme-prefixed external record ids like "gh:4287309009" or "li:90183721" —
// a short lowercase scheme, a colon, then an id token that carries a digit.
// These are connector-internal ids (greenhouse job, linkedin profile, …), never
// something a person reads. The digit requirement keeps human "word:word"
// values (e.g. a label) from being mistaken for a code.
const SCHEME_CODE_RE = /^[a-z][a-z0-9]{0,7}:[a-z0-9-]{4,}$/i;

/** True when a single value is shaped like a machine code (UUID / long hex / scheme id). */
function isCodeScalar(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (UUID_RE.test(v) || LONG_HEX_RE.test(v)) return true;
  if (SCHEME_CODE_RE.test(v) && /\d/.test(v)) return true;
  return false;
}

/**
 * True when a key/value pair is a machine code a human can't act on: id / hash
 * / event-id style keys, a value that is just a UUID / long hex / scheme id, or
 * an array that is mostly such codes (a connector's seen-set / id watermark).
 * Drives what the attributes grid hides from the default view (everything stays
 * in the raw JSON toggle and the API). Shape-based only — no key names baked in,
 * so a new connector's bookkeeping is hidden without code changes.
 */
export function looksLikeCode(key: string, value: unknown): boolean {
  const k = key.replace(/^_+/, '').toLowerCase();
  if (k === 'id' || k === 'uuid' || k === 'guid') return true;
  if (/(_id|_uuid|_guid|_hash|_key)$/.test(k)) return true;
  if (k.endsWith('hash')) return true;
  if (isCodeScalar(value)) return true;
  if (Array.isArray(value) && value.length > 0) {
    const codeish = value.filter(isCodeScalar).length;
    if (codeish >= Math.ceil(value.length * 0.6)) return true;
  }
  return false;
}

/**
 * True when an attribute should stay out of the human grid: an internal
 * `_`-prefixed key, a machine code (see looksLikeCode), or a nested object —
 * structured connector metadata is never a clean human field. Hidden values
 * remain in the raw JSON toggle and the API the agent reads.
 */
export function isMachineAttribute(key: string, value: unknown): boolean {
  if (key.startsWith('_')) return true;
  if (looksLikeCode(key, value)) return true;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return true;
  return false;
}
