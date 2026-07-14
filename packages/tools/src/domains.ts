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

/** Does the entity name plausibly own this host? See module comment. */
export function nameMatchesHost(name: string, host: string): boolean {
  const label = (host.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const joined = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!label || !joined) return false;
  if (joined.includes(label) || label.includes(joined)) return true;
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return tokens.some((t) => label.includes(t));
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
