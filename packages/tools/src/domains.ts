/**
 * Derive account web domains from the work-email addresses of linked contacts.
 *
 * CSV imports often carry contact emails but no website column (the Sudden
 * import: 98 contacts with real work emails, 0 account domains). An email at
 * a corporate host pins the employer's domain deterministically — no LLM, no
 * provider credits. A missing domain otherwise blocks every domain-keyed step:
 * own-site research angles, Hunter contact pulls, the ATS identity check.
 *
 * Rules:
 *  - Consumer mail hosts prove nothing about the employer → ignored.
 *  - An account whose contacts disagree (2+ distinct corporate hosts) is
 *    skipped, not guessed.
 *  - The account name must match the host label (either contains the other,
 *    or a name word appears in the label). Contact lists carry agency,
 *    consultant, and partner emails — "IMAX" with a contact at amazon.com
 *    must NOT become imax→amazon.com. A wrong domain is worse than none: it
 *    poisons the research identity gate and Hunter lookups. Precision over
 *    recall; the skipped ones stay eligible for future domain sources.
 *  - Existing attributes.domain is never overwritten.
 *
 * Attribute writes go straight to entities.attributes, matching the existing
 * connector pattern (attributes is bookkeeping, not event-sourced state).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain } from './ingest.ts';
import { fetchAll } from './paginate.ts';
import { runExaSearch } from './exa_search.ts';
import { recordActivityMarker, ACTIVITY_MARKERS } from './activity_markers.ts';

// Consumer mail providers. Universal across verticals/customers, so a code
// constant is right — same reasoning as NON_COMPANY_HOSTS in ingest.ts.
const FREEMAIL_HOSTS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'ymail.com',
  'hotmail.com', 'hotmail.fr', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru',
  'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'mail.ru',
  'orange.fr', 'free.fr', 'wanadoo.fr', 'sfr.fr', 'laposte.net', 'comcast.net', 'att.net',
]);

/** Corporate domain from an email address, or null (invalid / consumer host). */
export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const host = normalizeDomain(email.slice(at + 1));
  if (!host || FREEMAIL_HOSTS.has(host)) return null;
  return host;
}

/**
 * The parts of a host that could carry the company's name, most specific first.
 *
 * `host.split('.')[0]` only works when there is no subdomain. Plenty of real
 * corporate sites have one, and taking the first label then compares the wrong
 * string: `tv.movistar.com.ar` yields "tv", `m.ixigua.com` yields "m". Both got
 * their accounts rejected as name_mismatch against companies they genuinely
 * belong to.
 *
 * There is no public-suffix list here, so the trailing 1-2 labels are dropped
 * heuristically: the last label is always a TLD, and the one before it too when
 * it is a short registry label like the "com" in "com.ar" or "co" in "co.uk".
 * What remains is every label that could plausibly be the brand, plus the whole
 * thing concatenated, so callers can test against all of them.
 */
/**
 * The registrable domain — what a contact provider can actually be queried
 * with. `jobs.lionsgate.com` becomes `lionsgate.com`, `tv.movistar.com.ar`
 * becomes `movistar.com.ar`.
 *
 * Search results for a company routinely land on a subdomain (careers, investor
 * relations, a regional site). Storing that as the account's domain is worse
 * than storing nothing: Hunter finds no addresses under it, and the account now
 * looks resolved so the backfill stops retrying it.
 *
 * Same registry-label heuristic as hostNameLabels — no public-suffix list here.
 */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const REGISTRY_LABELS = new Set(['com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
  const keep = REGISTRY_LABELS.has(parts[parts.length - 2]!) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export function hostNameLabels(host: string): string[] {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts;
  // Drop the TLD, and a second-level registry label when it looks like one.
  const REGISTRY_LABELS = new Set(['com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
  let end = parts.length - 1;
  if (end > 1 && REGISTRY_LABELS.has(parts[end - 1]!)) end -= 1;
  const kept = parts.slice(0, end).map((p) => p.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (!kept.length) return [];
  // The concatenation is built from the ORIGINAL order ("moviesandtv" + "myvi"),
  // then the individual labels are listed brand-first.
  const concatenated = kept.join('');
  return [...new Set([...[...kept].reverse(), concatenated])];
}

/**
 * The initials of a multi-word name, e.g. "Warner Brothers Discovery" -> "wbd".
 *
 * Only from three or more significant words, and only returned at three or more
 * characters. Two-letter initialisms collide with far too much — "Total Play"
 * would claim any tp.* host — and the whole point of the guard is to be wrong
 * rarely rather than to match often.
 */
function nameAcronym(name: string): string | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !['the', 'and', 'for', 'inc', 'llc', 'ltd', 'plc', 'corp', 'group'].includes(w));
  if (words.length < 3) return null;
  const acronym = words.map((w) => w[0]).join('');
  return acronym.length >= 3 ? acronym : null;
}

/** Does the entity name plausibly own this host? See module comment. */
export function nameMatchesHost(name: string, host: string): boolean {
  const labels = hostNameLabels(host);
  const joined = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!labels.length || !joined) return false;
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  // Companies routinely trade under their initials, and nothing above can see
  // it: "Warner Brothers Discovery" shares no substring with wbd.com, so their
  // real domain was rejected as a name_mismatch and the account sat unreachable
  // despite clearing both score gates. Exact match on the whole label only — a
  // substring test would let "wbd" claim anything containing those letters.
  const acronym = nameAcronym(name);
  return labels.some((label) =>
    joined.includes(label) || label.includes(joined)
    || tokens.some((t) => label.includes(t))
    || (acronym !== null && label === acronym),
  );
}

export interface DomainBackfillResult {
  accounts_with_contact_email: number;
  domains_set: number;
  skipped_has_domain: number;
  skipped_conflict: number;
  skipped_name_mismatch: Array<{ name: string; domain: string }>;
  set: Array<{ entity_id: string; name: string; domain: string }>;
}

/**
 * Set attributes.domain on every account that (a) lacks one and (b) has linked
 * contacts whose work emails agree on a single corporate host. `apply: false`
 * reports what would change without writing.
 */
export async function backfillAccountDomainsFromContactEmails(
  supabase: SupabaseClient,
  opts: { workspace_id: string; apply?: boolean },
): Promise<DomainBackfillResult> {
  const { workspace_id } = opts;
  const apply = opts.apply ?? true;

  const factCols = 'id, subject_entity, object_entity, object_text, supersedes';
  interface FactRow { id: string; subject_entity: string; object_entity: string | null; object_text: string | null; supersedes: string | null }
  const current = (rows: FactRow[]) => {
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
    return rows.filter((r) => !pointedTo.has(r.id));
  };

  const worksAt = current(await fetchAll<FactRow>((from, to) =>
    supabase.from('facts').select(factCols)
      .eq('workspace_id', workspace_id).eq('predicate', 'works_at')
      .order('id', { ascending: true }).range(from, to)));
  const emails = current(await fetchAll<FactRow>((from, to) =>
    supabase.from('facts').select(factCols)
      .eq('workspace_id', workspace_id).eq('predicate', 'email')
      .order('id', { ascending: true }).range(from, to)));

  const accountByContact = new Map<string, string>();
  for (const w of worksAt) if (w.object_entity) accountByContact.set(w.subject_entity, w.object_entity);

  // account → distinct corporate hosts seen across its contacts
  const hostsByAccount = new Map<string, Set<string>>();
  for (const e of emails) {
    const account = accountByContact.get(e.subject_entity);
    if (!account) continue;
    const host = domainFromEmail(e.object_text);
    if (!host) continue;
    const set = hostsByAccount.get(account) ?? new Set<string>();
    set.add(host);
    hostsByAccount.set(account, set);
  }

  const out: DomainBackfillResult = {
    accounts_with_contact_email: hostsByAccount.size,
    domains_set: 0, skipped_has_domain: 0, skipped_conflict: 0,
    skipped_name_mismatch: [], set: [],
  };
  if (!hostsByAccount.size) return out;

  const accountIds = [...hostsByAccount.keys()];
  const entities: Array<{ id: string; name: string; attributes: Record<string, unknown> | null }> = [];
  for (let i = 0; i < accountIds.length; i += 150) {
    const { data, error } = await supabase.from('entities')
      .select('id, name, attributes').in('id', accountIds.slice(i, i + 150));
    if (error) throw new Error(error.message);
    entities.push(...((data ?? []) as typeof entities));
  }

  for (const ent of entities) {
    const hosts = hostsByAccount.get(ent.id)!;
    const existing = ent.attributes?.domain;
    if (typeof existing === 'string' && existing.length > 0) { out.skipped_has_domain++; continue; }
    if (hosts.size !== 1) { out.skipped_conflict++; continue; }
    const domain = [...hosts][0] as string;
    if (!nameMatchesHost(ent.name, domain)) {
      out.skipped_name_mismatch.push({ name: ent.name, domain });
      continue;
    }
    if (apply) {
      const { error } = await supabase.from('entities')
        .update({ attributes: { ...(ent.attributes ?? {}), domain } })
        .eq('id', ent.id);
      if (error) throw new Error(`${ent.name}: ${error.message}`);
    }
    out.domains_set++;
    out.set.push({ entity_id: ent.id, name: ent.name, domain });
  }
  return out;
}

// ─── Search-based resolution ─────────────────────────────────────────────────

export interface DomainResolveRejection {
  url: string;
  host: string | null;
  /**
   * not_a_company_domain: normalizeDomain rejected it (social host, no dot, unparseable).
   * name_mismatch: nameMatchesHost said the entity does not plausibly own it.
   * weak_evidence: name matched, but the host appeared only once and was not an
   *   exact rank-1 brand match (see the corroboration rule below).
   */
  reason: 'not_a_company_domain' | 'name_mismatch' | 'weak_evidence';
}

export interface DomainResolveOutcome {
  status: 'resolved' | 'no_match' | 'already_has_domain' | 'search_error';
  domain: string | null;
  evidence_urls: string[];
  rejections: DomainResolveRejection[];
  error?: string;
}

/**
 * Resolve attributes.domain for one account with a single Exa search
 * ("<name>" official website, 3 results), gated by the same precision rules as
 * the contact-email backfill above: a wrong domain poisons the research
 * identity gate, the ATS check, and contact pulls, so nothing is written unless
 * a candidate host passes nameMatchesHost AND has corroboration:
 *   - the host appears in at least 2 of the results, OR
 *   - it is the top-ranked hit and its host label exactly equals the entity
 *     name (alphanumerics only). A loose token match on a single rank-1 result
 *     is not enough: on the live book it wrote "Stage" (Indian OTT) to
 *     stage-entertainment.com (theater company) and "OVI Technologies" to
 *     ovistechnologies.com (unrelated web-dev shop). Exact-label singletons
 *     like dashverse.ai and mansa.com stay in.
 *
 * Never overwrites an existing attributes.domain. With `apply: false` it only
 * reports: no attribute write, no markers (a dry run must not start cooldowns).
 * On apply it records DOMAIN_RESOLVED / DOMAIN_RESOLVE_FAILED activity markers
 * so the research runner and the bulk backfill don't re-spend a search on the
 * same account. A transport/credit failure writes NO marker: it says nothing
 * about the account, and a 30-day cooldown would outlive a credit top-up.
 */
export async function resolveDomainViaSearch(
  supabase: SupabaseClient,
  opts: {
    workspace_id: string;
    entity_id: string;
    entity_name: string;
    exa_api_key: string;
    apply?: boolean;
    actor_id?: string;
  },
): Promise<DomainResolveOutcome> {
  const { workspace_id, entity_id, entity_name, exa_api_key } = opts;
  const apply = opts.apply ?? true;
  const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: opts.actor_id ?? 'domain_resolver' };

  const ent = await supabase.from('entities').select('attributes').eq('id', entity_id).maybeSingle();
  if (ent.error) return { status: 'search_error', domain: null, evidence_urls: [], rejections: [], error: ent.error.message };
  const attributes = (ent.data?.attributes ?? {}) as Record<string, unknown>;
  const existing = attributes.domain;
  if (typeof existing === 'string' && existing.length > 0) {
    return { status: 'already_has_domain', domain: existing, evidence_urls: [], rejections: [] };
  }

  const query = `"${entity_name}" official website`;
  // 3 results / 600 chars: the resolver only needs snippets to verify identity,
  // not full pages, and every extra result is a paid contents-text fetch.
  const res = await runExaSearch(exa_api_key, { query, num_results: 3, text_chars: 600 });
  if (!res.ok) {
    const error = `Exa ${res.status ?? ''} ${res.error ?? ''}`.trim();
    return { status: 'search_error', domain: null, evidence_urls: [], rejections: [], error };
  }

  const hosts = res.results.map((r) => normalizeDomain(r.url));
  // Count by REGISTRABLE domain, not by full host. Two results on
  // investors.acme.com and about.acme.com are two pieces of evidence for
  // acme.com; counting them as one each left real companies stuck on
  // weak_evidence.
  const countByHost = new Map<string, number>();
  for (const h of hosts) if (h) {
    const reg = registrableDomain(h);
    countByHost.set(reg, (countByHost.get(reg) ?? 0) + 1);
  }

  const rejections: DomainResolveRejection[] = [];
  const joinedName = entity_name.toLowerCase().replace(/[^a-z0-9]/g, '');
  let domain: string | null = null;
  for (let rank = 0; rank < res.results.length; rank++) {
    const url = res.results[rank]!.url;
    const host = hosts[rank] ?? null;
    if (!host) { rejections.push({ url, host, reason: 'not_a_company_domain' }); continue; }
    if (!nameMatchesHost(entity_name, host)) { rejections.push({ url, host, reason: 'name_mismatch' }); continue; }
    if ((countByHost.get(registrableDomain(host)) ?? 0) < 2) {
      // A host that appears once still counts when it is the top hit for
      // `"<name>" official website` AND one of its name-bearing labels is the
      // company name. Testing only host.split('.')[0] compared the subdomain:
      // "tv" for tv.movistar.com.ar, against a joined name of "movistartv".
      const labels = hostNameLabels(host);
      if (rank !== 0 || !labels.includes(joinedName)) { rejections.push({ url, host, reason: 'weak_evidence' }); continue; }
    }
    // Store the registrable domain, never the subdomain the search happened to
    // land on. A contact provider queried with jobs.lionsgate.com returns
    // nothing, and the account would still be marked resolved so the backfill
    // would stop retrying it — strictly worse than leaving it blank.
    const registrable = registrableDomain(host);
    // ...but only if the company owns THAT, not just the subdomain. A brand
    // hosted on someone else's platform matches the subdomain label while the
    // registrable domain belongs to the platform: widekhaliji.blueonline.tv
    // would otherwise file "WideKhaliji" under blueonline.tv and send every
    // contact lookup to the wrong company.
    if (!nameMatchesHost(entity_name, registrable)) {
      rejections.push({ url, host, reason: 'name_mismatch' });
      continue;
    }
    domain = registrable;
    break;
  }

  if (!domain) {
    if (apply) {
      await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.DOMAIN_RESOLVE_FAILED, entity_id, {
        query,
        rejections: rejections.slice(0, 5),
        summary: `no result passed the domain guard (${rejections.length} rejected)`,
      });
    }
    return { status: 'no_match', domain: null, evidence_urls: [], rejections };
  }

  // Evidence is every result under the same registrable domain, so a subdomain
  // hit still cites the page it actually came from.
  const evidence_urls = res.results
    .filter((r, i) => hosts[i] && registrableDomain(hosts[i]!) === domain)
    .map((r) => r.url).slice(0, 5);
  if (apply) {
    const { error } = await supabase.from('entities')
      .update({ attributes: { ...attributes, domain } })
      .eq('id', entity_id);
    if (error) return { status: 'search_error', domain: null, evidence_urls, rejections, error: error.message };
    await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.DOMAIN_RESOLVED, entity_id, { domain, evidence_urls });
  }
  return { status: 'resolved', domain, evidence_urls, rejections };
}
