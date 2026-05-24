import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, vectorLiteral } from '@agent-crm/primitives';

/**
 * Compute and upsert a default-perspective embedding for an entity. Connectors
 * that create entities should call this so query() and any similarity-based
 * scoring works on connector-imported data, the same way seed_demo does.
 *
 * The embedded text is what an agent sees when retrieving the entity in a
 * semantic search context. Keep it dense and descriptive.
 */
/**
 * Last-line defense against junk entity names from connector extraction.
 * The LLM is told to reject obvious patterns in its prompt; this catches
 * what slips through. Returns a rejection reason if the name should be
 * dropped, or null if it looks valid.
 *
 * `publicationBlocklist` is the workspace-configured list of brand/publication
 * names to reject. It MUST come from `workspaces.policy.publication_blocklist`
 * — never hardcode names here, even as defaults. Different verticals have
 * different junk patterns; "no default" is the default.
 *
 * The shape checks (capitalization, length, listicle patterns) are
 * vertical-neutral and stay in code.
 */
export function validateCompanyName(
  name: string,
  domain: string | null,
  publicationBlocklist: string[] = [],
): string | null {
  const n = name.trim();
  if (n.length < 2) return 'not_a_company';

  const isMultiWord = /\s/.test(n);
  if (!isMultiWord) {
    if (n === n.toLowerCase() && n.length > 3) return 'user_handle_not_company';
    // Cram-job pattern: 2+ leading caps + lowercase. Pure acronyms (all caps)
    // fail the [a-z] guard so stay allowed.
    if (/^[A-Z]{2,}[a-z]/.test(n)) return 'crammed_phrase';
    // Single-token > 14 chars is almost always a crammed multi-word phrase.
    if (n.length > 14) return 'crammed_phrase';
  }

  if (isMultiWord && n === n.toLowerCase()) return 'buzzword_phrase';

  if (isMultiWord) {
    const words = n.split(/\s+/);
    if (words.length >= 5) return 'article_title';
    if (/\s(story|guide|tips|trends|outlooks?|insights|review|reviews|news)$/i.test(n)) return 'article_title';
    if (words.length >= 4 && /^(best|top|how\s+to|why|what\s+is|guide\s+to|the\s+ultimate|the\s+best|the\s+top)\b/i.test(n)) return 'article_title';
  }

  if (publicationBlocklist.length) {
    const lower = n.toLowerCase();
    for (const b of publicationBlocklist) {
      if (b && lower === b.trim().toLowerCase()) return 'media_publication';
    }
  }

  if (domain) {
    const d = domain.toLowerCase();
    if (d.includes('news') || d.includes('blog') || d.includes('report') || d.includes('today')) {
      if (!/^[A-Z]/.test(n)) return 'media_publication';
    }
  }

  return null;
}

/**
 * Watch-mode default: every active (non-dropped) account in the workspace.
 *
 * Connectors that support `watch_entities` should call this when the caller
 * passes no explicit list — same shape HN uses today. Setup-first: a user
 * enabling a connector in watch mode shouldn't have to maintain a list of
 * entity IDs; we read what's currently in the workspace minus what's been
 * dropped via dropped_until.
 *
 * Returns each entity with a pre-built alias set so connectors can match
 * mentions via {@link matchAlias} without re-deriving aliases per-hit.
 */
export interface WatchedAccount {
  entity_id: string;
  name: string;
  aliases: string[];
}

export async function getWatchedAccounts(
  supabase: SupabaseClient,
  workspace_id: string,
  limit = 5000,
): Promise<WatchedAccount[]> {
  const [accountsRes, dropsRes] = await Promise.all([
    supabase.from('entities').select('id, name, attributes')
      .eq('workspace_id', workspace_id).eq('kind', 'account').limit(limit),
    supabase.from('facts').select('subject_entity, object_text')
      .eq('workspace_id', workspace_id).eq('predicate', 'dropped_until').is('supersedes', null),
  ]);
  if (accountsRes.error) throw new Error(`load accounts failed: ${accountsRes.error.message}`);
  const dropped = new Set<string>();
  const now = Date.now();
  for (const f of dropsRes.data ?? []) {
    const t = Date.parse(f.object_text as string);
    if (Number.isFinite(t) && t > now) dropped.add(f.subject_entity as string);
  }
  return ((accountsRes.data ?? []) as Array<{ id: string; name: string; attributes: Record<string, unknown> | null }>)
    .filter((r) => !dropped.has(r.id))
    .map((r) => {
      const domain = (r.attributes?.domain as string | undefined) ?? null;
      return {
        entity_id: r.id,
        name: r.name,
        aliases: buildAliases(r.name, domain),
      };
    });
}

/**
 * Generate the canonical alias set for an entity. The matcher does word-
 * boundary regex against these — NOT substring matches on raw entity names
 * (short names like "Char" / "Nomi" otherwise collide with English fragments
 * like "charges" / "economic").
 *
 * Variants included (deduped, lowercased, min 3 chars):
 *  - the canonical name itself
 *  - CamelCase split with a space (FurtherAI → "further ai") — handles the
 *    common stylistic variant where people insert a space the brand omits
 *  - the full cleaned domain (alice.tech → "alice.tech") — catches direct
 *    domain mentions like "check out alice.tech"
 *
 * DELIBERATELY EXCLUDED:
 *  - First chunk of CamelCase ("FurtherAI" → "further" alone). Strips the
 *    distinctive part of the name and leaves a generic English word.
 *    Observed false positives: TokenOwl → "token", HumanLayer → "human".
 *  - Suffix-stripped versions ("Boom AI" → "boom"). Same problem — the
 *    suffix is often the differentiating part of the name.
 *  - Domain root extraction (video.golpoai.com → "video"). The leftmost
 *    segment is often a product subdomain, not the brand. For 2-part
 *    domains where it IS the brand (browse.dev → "browse"), the segment is
 *    often a generic English word that matches everywhere. Without a
 *    Public Suffix List + semantic verification, no domain-root heuristic
 *    gets this right. We accept slightly lower recall — a real mention
 *    using only the URL-prefix form is rare.
 *
 * Trade-off acknowledged: signals that say "Further is hiring" (without
 * the AI suffix) won't match FurtherAI. False positives are much worse
 * than occasional missed mentions, and most coverage uses the full name.
 */
export function buildAliases(name: string, domain: string | null | undefined): string[] {
  const aliases = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t.length >= 3) aliases.add(t);
  };

  add(name);

  if (domain) {
    const cleaned = domain.toLowerCase().replace(/^www\./, '');
    add(cleaned);
  }

  // CamelCase split with space — does NOT also add the first chunk alone.
  // "FurtherAI" → ["furtherai", "further ai"]; not "further".
  const camelSplit = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (camelSplit !== name) add(camelSplit);

  return [...aliases];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary regex match against an alias set. Returns the first alias
 * that matches (callers may want to refactor to "longest match wins" later
 * if multi-alias collisions become a problem).
 *
 * Word boundaries (\b) are why this beats substring matching: "Char" only
 * matches the standalone token "Char" / "char", not the substring inside
 * "charges" or "character".
 */
export function matchAlias(haystack: string, aliases: string[]): string | null {
  if (!haystack || !aliases.length) return null;
  const hay = haystack.toLowerCase();
  for (const a of aliases) {
    // \b is too lax for tokens that start/end with punctuation (e.g. ".AI").
    // The escape above handles regex special chars; \b around it still works
    // for alphanumeric edges, which covers the false-positive class we hit.
    const re = new RegExp(`\\b${escapeRegex(a)}\\b`, 'i');
    if (re.test(hay)) return a;
  }
  return null;
}

export async function upsertEntityEmbedding(
  supabase: SupabaseClient,
  entity_id: string,
  embedText: string,
  perspective: string = 'default',
): Promise<void> {
  const vec = await embed(embedText);
  const { error } = await supabase
    .from('entity_embeddings')
    .upsert({
      entity_id,
      perspective,
      embedding: vectorLiteral(vec) as unknown as string,
    });
  if (error) throw new Error(`upsertEntityEmbedding failed: ${error.message}`);
}
