/**
 * Alias resolution — the other names an account's coverage is written under.
 *
 * The research name gate and every watch-mode connector test a page against the
 * account's name and domain root. That fails outright for a company the press
 * only ever calls by its product: Crazy Maple Studio (crazymaplestudios.com) is
 * covered as "ReelShort", so every genuine article about it shares no string
 * with either token and gets dropped before an LLM ever sees it.
 *
 * No string surgery on the registered name can produce the product name, so the
 * record has to carry it in `attributes.aliases`. This module is how it gets
 * there without a hand-written database edit: read the company's own site, ask
 * what names it operates under, and keep only the candidates that survive the
 * guards below.
 *
 * The guards matter more than the extraction. An alias WIDENS the name gate, so
 * a bad one silently readmits the junk the gate exists to remove — the failure
 * is invisible, unlike a missing alias, which shows up as an account with no
 * signals. Every candidate must clear all four:
 *
 *   too_short   — under the gate's 4-character floor. Shorter tokens are
 *                 discarded by the gate anyway, so storing one records a fix
 *                 that will never fire.
 *   redundant   — already reachable from the name or the domain root. "Cineverse
 *                 Networks" on cineverse.com adds nothing; the gate matches it.
 *   absent      — not present in the company's own site text. The extraction
 *                 model cannot invent a name the company never claims.
 *   generic     — present, but never used as a proper noun. This is the one that
 *                 protects the corpus: a site that says "we build streaming apps"
 *                 must not yield the alias "streaming", which would match every
 *                 page in the vertical. See {@link usedAsProperNoun}.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { runExaSearch } from './exa_search.ts';
import { recordActivityMarker, ACTIVITY_MARKERS } from './activity_markers.ts';
import { readEntityAliases } from './research_strategy.ts';
import { entityIdsOfType } from './entity_types.ts';

/**
 * Matches MIN_DISCRIMINATING_CHARS in the name gate. The two floors have to
 * agree: an alias the gate discards is a fix that silently never fires.
 */
export const ALIAS_MIN_CHARS = 4;

/**
 * Bounds what one account can carry. Every alias is another token tested against
 * every candidate page, and a list this long already means the extraction is
 * guessing rather than reading a brand off the page.
 */
export const MAX_ALIASES = 5;

const ALIAS_MODEL = 'deepseek-v4-flash';

/** Own-site text pulled for extraction. Enough for a homepage plus an about page. */
const GROUNDING_CHARS = 2000;

export type AliasRejectReason = 'too_short' | 'redundant' | 'absent' | 'generic' | 'duplicate';

export interface AliasRejection {
  alias: string;
  reason: AliasRejectReason;
}

export interface AliasValidation {
  accepted: string[];
  rejected: AliasRejection[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The tokens the name gate can already match on its own: each bracket/slash-split
 * half of the name, and the domain root. Anything an alias adds must sit outside
 * this set or it is dead weight.
 */
function gateTokens(name: string, domain: string): string[] {
  const parts = name.split(/[/()[\]]/).map(norm).filter(Boolean);
  const root = norm((domain || '').split('.')[0] ?? '');
  return [...parts, root].filter(Boolean);
}

/**
 * Is this candidate used as a NAME on the page, rather than as a common word
 * that happens to appear there?
 *
 * The test is capitalization away from a sentence start. English capitalizes the
 * first word of a sentence regardless of what it is, so an occurrence there
 * proves nothing; an occurrence mid-sentence that still carries the candidate's
 * own capitalization is a proper noun. "ReelShort tops the charts" and "...the
 * ReelShort app" both pass. A site that says "we build streaming apps" yields no
 * capitalized mid-sentence "Streaming", so the candidate "streaming" fails and
 * never widens the gate.
 *
 * All-caps acronyms (OSN, HBO) pass on the same rule. A candidate that only ever
 * opens a sentence is treated as unproven rather than rejected on its merits —
 * the conservative direction, since the cost is a missing alias we can add later,
 * not a corrupted corpus.
 */
export function usedAsProperNoun(alias: string, text: string): boolean {
  if (!alias.trim() || !text) return false;
  const escaped = alias.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Tolerate the spacing the site uses ("ReelShort" vs "Reel Short") without
  // letting the match run across unrelated words: existing spaces become
  // optional, and so does every internal CamelCase seam.
  const pattern = escaped
    .replace(/\s+/g, '\\s*')
    .replace(/([a-z0-9])(?=[A-Z])/g, '$1\\s*');
  const re = new RegExp(`(?<![A-Za-z0-9])(${pattern})(?![A-Za-z0-9])`, 'g');
  for (const m of text.matchAll(re)) {
    const hit = m[1] ?? '';
    if (!/[A-Z]/.test(hit)) continue;
    const before = text.slice(0, m.index ?? 0);
    if (!before) continue;                    // opens the text
    if (/\n|\r/.test(before.slice(-40).match(/\s*$/)?.[0] ?? '')) continue; // opens a line
    // Look past the spacing to the character that actually ended the previous
    // clause. Reading only the single character before the match treated the
    // space in "app. ReelShort" as ordinary prose and accepted a word that had
    // only ever opened a sentence.
    const prev = before.replace(/\s+$/, '').slice(-1);
    if (!prev || /[.!?|•·]/.test(prev)) continue;
    return true;
  }
  return false;
}

/**
 * Apply every guard to a candidate list. Pure and synchronous so the rules can be
 * asserted without a network or a model, which is the only reason they can be
 * trusted — the extraction step above them is not deterministic.
 *
 * `existing` lets a second run add to an account without re-proposing what it
 * already carries.
 */
export function validateAliases(
  candidates: string[],
  name: string,
  domain: string,
  ownSiteText: string,
  existing: string[] = [],
): AliasValidation {
  const accepted: string[] = [];
  const rejected: AliasRejection[] = [];
  const blocked = new Set(gateTokens(name, domain));
  const seen = new Set(existing.map(norm));

  for (const raw of candidates) {
    const alias = String(raw ?? '').trim();
    if (!alias) continue;
    const n = norm(alias);
    if (n.length < ALIAS_MIN_CHARS) { rejected.push({ alias, reason: 'too_short' }); continue; }
    if (seen.has(n)) { rejected.push({ alias, reason: 'duplicate' }); continue; }
    // Redundant in either direction: the alias contains a token the gate already
    // matches, or a gate token contains the alias.
    if ([...blocked].some((t) => t.includes(n) || n.includes(t))) {
      rejected.push({ alias, reason: 'redundant' });
      continue;
    }
    if (!norm(ownSiteText).includes(n)) { rejected.push({ alias, reason: 'absent' }); continue; }
    if (!usedAsProperNoun(alias, ownSiteText)) { rejected.push({ alias, reason: 'generic' }); continue; }
    seen.add(n);
    accepted.push(alias);
    if (accepted.length + existing.length >= MAX_ALIASES) break;
  }
  return { accepted, rejected };
}

export type AliasResolveStatus =
  | 'resolved'
  | 'no_candidates'
  | 'all_rejected'
  | 'no_domain'
  | 'already_has_aliases'
  | 'no_own_site_text'
  | 'search_error';

export interface AliasResolveOutcome {
  status: AliasResolveStatus;
  aliases: string[];
  rejected: AliasRejection[];
  evidence_urls: string[];
  error?: string;
}

/** Pull the company's own pages as the only evidence an alias is allowed to rest on. */
async function fetchOwnSiteText(
  exa_api_key: string,
  name: string,
  domain: string,
): Promise<{ text: string; urls: string[]; error?: string }> {
  const res = await runExaSearch(exa_api_key, {
    query: name,
    num_results: 3,
    text_chars: GROUNDING_CHARS,
    include_domains: [domain],
  });
  if (!res.ok) return { text: '', urls: [], error: `Exa ${res.status ?? ''} ${res.error ?? ''}`.trim() };
  // include_domains can leak a loosely-related result; an alias may only be
  // learned from a page the company actually controls.
  const own = res.results.filter((r) => {
    try {
      const h = new URL(r.url).hostname.replace(/^www\./, '').toLowerCase();
      return h === domain || h.endsWith(`.${domain}`);
    } catch { return false; }
  });
  return {
    text: own.map((r) => [r.title, r.text].filter(Boolean).join('\n')).join('\n\n'),
    urls: own.map((r) => r.url).slice(0, 5),
  };
}

async function extractAliasCandidates(name: string, domain: string, ownSiteText: string): Promise<string[]> {
  const sys = `You read a company's OWN website text and list the other names its coverage is published under.

COMPANY: ${name}
WEBSITE: ${domain}

Return a name ONLY if the text shows this company operates or publishes under it — an app, product, platform, service, or former/trading name that a journalist would use as the subject of a headline INSTEAD of "${name}".

Do NOT return:
- the company name itself, or a longer/shorter form of it
- a category, industry, or descriptive phrase ("streaming", "short drama", "mobile apps")
- a customer, partner, investor, parent, or competitor name
- a person's name, a job title, or a place
- anything not written in the text

Most companies have none. An empty list is the correct and common answer.

Return JSON only: {"aliases":["Name One","Name Two"]}`;

  const llm = await chatComplete({
    model: ALIAS_MODEL,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: ownSiteText.slice(0, 6000) },
    ],
  });
  const parsed = JSON.parse(llm.text) as { aliases?: unknown };
  if (!Array.isArray(parsed.aliases)) return [];
  return parsed.aliases.filter((a): a is string => typeof a === 'string');
}

/**
 * Resolve and (by default) store the aliases for one account.
 *
 * Mirrors resolveDomainViaSearch: one paid search, guards that abstain rather
 * than guess, an activity marker either way so a failed attempt is visible and
 * a sweep can cool the account down instead of re-spending on it every tick.
 *
 * `apply: false` runs the whole thing and writes nothing, which is what the
 * sweep uses for a dry run.
 */
export async function resolveAliasesViaSearch(
  supabase: SupabaseClient,
  opts: {
    workspace_id: string;
    entity_id: string;
    entity_name: string;
    exa_api_key: string;
    apply?: boolean;
    actor_id?: string;
  },
): Promise<AliasResolveOutcome> {
  const { workspace_id, entity_id, entity_name, exa_api_key } = opts;
  const apply = opts.apply ?? true;
  const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: opts.actor_id ?? 'alias_resolver' };
  const empty = { aliases: [], rejected: [], evidence_urls: [] };

  const ent = await supabase.from('entities').select('attributes').eq('id', entity_id).maybeSingle();
  if (ent.error) return { status: 'search_error', ...empty, error: ent.error.message };
  const attributes = (ent.data?.attributes ?? {}) as Record<string, unknown>;
  const existing = readEntityAliases(attributes);
  if (existing.length) return { status: 'already_has_aliases', ...empty, aliases: existing };

  const domain = String(attributes.domain ?? '').trim().toLowerCase();
  // Without a domain there is no page we can prove the company controls, so
  // there is nothing an alias could be checked against. The name gate abstains
  // for these accounts anyway, so they lose nothing by being skipped.
  if (!domain) return { status: 'no_domain', ...empty };

  const site = await fetchOwnSiteText(exa_api_key, entity_name, domain);
  if (site.error) return { status: 'search_error', ...empty, error: site.error };
  if (!site.text.trim()) {
    if (apply) {
      await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.ALIASES_RESOLVE_FAILED, entity_id, {
        summary: 'no readable page on the company own domain',
      });
    }
    return { status: 'no_own_site_text', ...empty, evidence_urls: site.urls };
  }

  let candidates: string[];
  try {
    candidates = await extractAliasCandidates(entity_name, domain, site.text);
  } catch (e) {
    // A model or parse failure is a transport problem, not evidence the account
    // has no alias. No marker, so the sweep retries it rather than cooling down.
    return { status: 'search_error', ...empty, evidence_urls: site.urls, error: e instanceof Error ? e.message : String(e) };
  }
  if (!candidates.length) {
    if (apply) {
      await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.ALIASES_RESOLVE_FAILED, entity_id, {
        summary: 'own site names no other brand',
      });
    }
    return { status: 'no_candidates', ...empty, evidence_urls: site.urls };
  }

  const { accepted, rejected } = validateAliases(candidates, entity_name, domain, site.text);
  if (!accepted.length) {
    if (apply) {
      await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.ALIASES_RESOLVE_FAILED, entity_id, {
        rejected: rejected.slice(0, 5),
        summary: `no candidate passed the alias guards (${rejected.length} rejected)`,
      });
    }
    return { status: 'all_rejected', ...empty, rejected, evidence_urls: site.urls };
  }

  if (apply) {
    const { error } = await supabase.from('entities')
      .update({ attributes: { ...attributes, aliases: accepted } })
      .eq('id', entity_id);
    if (error) return { status: 'search_error', ...empty, rejected, evidence_urls: site.urls, error: error.message };
    await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.ALIASES_RESOLVED, entity_id, {
      aliases: accepted,
      rejected: rejected.slice(0, 5),
      evidence_urls: site.urls,
    });
  }
  return { status: 'resolved', aliases: accepted, rejected, evidence_urls: site.urls };
}

export interface AliasBackfillResult {
  scanned: number;
  resolved: number;
  skipped: number;
  failed: number;
  searches: number;
  /** Raw provider errors, so the caller can pause on a credit wall. */
  errors: string[];
  byEntity: Array<{ entity_id: string; name: string; status: AliasResolveStatus; aliases: string[] }>;
}

/**
 * Sweep every account that could carry an alias and does not yet.
 *
 * This is the half the one-account resolver cannot cover: the accounts already
 * in the workspace were imported before any of this existed, and nobody knows
 * which of them are in the Crazy Maple Studio shape without looking. Bounded by
 * `limit` because each account costs one paid search plus one model call.
 *
 * Accounts already carrying aliases and accounts with no domain are skipped
 * without spending anything, and a previous failure cools the account down for
 * RETRY_DAYS so repeat runs move on to ones never tried.
 */
const RETRY_DAYS = 30;

export async function backfillAliases(
  supabase: SupabaseClient,
  opts: {
    workspace_id: string;
    exa_api_key: string;
    limit?: number;
    apply?: boolean;
    actor_id?: string;
  },
): Promise<AliasBackfillResult> {
  const { workspace_id, exa_api_key } = opts;
  const limit = opts.limit ?? 25;
  const apply = opts.apply ?? true;
  const out: AliasBackfillResult = { scanned: 0, resolved: 0, skipped: 0, failed: 0, searches: 0, errors: [], byEntity: [] };

  // Accounts only. Entity kind lives in an is_a fact, not a column, so a plain
  // entities select would spend paid searches reading contacts' own sites.
  const acctIds = await entityIdsOfType(supabase, workspace_id, 'account');
  const rows: Array<{ id: string; name: string; attributes: Record<string, unknown> | null }> = [];
  for (let i = 0; i < acctIds.length; i += 200) {
    const { data, error } = await supabase.from('entities')
      .select('id, name, attributes, archived_at')
      .in('id', acctIds.slice(i, i + 200))
      .is('archived_at', null);
    if (error) throw new Error(`load accounts failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; name: string; attributes: Record<string, unknown> | null }>) rows.push(r);
  }

  const eligible = rows.filter((r) => {
    const attrs = r.attributes ?? {};
    // A `_candidate` node is a thin placeholder that may never be promoted;
    // reading its site is spend with nothing downstream, same rule the domain
    // backfill scan applies.
    if (attrs._candidate === true) return false;
    if (!r.name?.trim()) return false;
    return !readEntityAliases(attrs).length && String(attrs.domain ?? '').trim().length > 0;
  });

  const cutoff = Date.now() - RETRY_DAYS * 86400 * 1000;
  const tried = await supabase.from('events')
    .select('target_id, occurred_at')
    .eq('workspace_id', workspace_id)
    .in('action', [ACTIVITY_MARKERS.ALIASES_RESOLVE_FAILED])
    .gte('occurred_at', new Date(cutoff).toISOString());
  const coolingDown = new Set((tried.data ?? []).map((e) => e.target_id as string));

  for (const r of eligible) {
    if (out.scanned >= limit) break;
    if (coolingDown.has(r.id)) { out.skipped++; continue; }
    out.scanned++;
    const res = await resolveAliasesViaSearch(supabase, {
      workspace_id,
      entity_id: r.id,
      entity_name: r.name,
      exa_api_key,
      apply,
      actor_id: opts.actor_id ?? 'alias_backfill',
    });
    out.searches++;
    if (res.status === 'resolved') out.resolved++;
    else if (res.status === 'search_error') {
      out.failed++;
      if (res.error) out.errors.push(res.error);
    } else out.skipped++;
    out.byEntity.push({ entity_id: r.id, name: r.name, status: res.status, aliases: res.aliases });
  }
  return out;
}
