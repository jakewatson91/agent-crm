/**
 * Repair stored account domains that a contact provider cannot use.
 *
 * Two faults, handled differently on purpose:
 *
 * 1. AGGREGATOR HOSTS — one host claimed by several different companies
 *    (app stores, video platforms). `play.google.com` was filed as the domain
 *    for three separate broadcasters, so every contact lookup for them queried
 *    Google. There is no salvaging these: clear the domain so the (now fixed)
 *    resolver re-runs and finds the real one. It retries within
 *    DOMAIN_BACKFILL_REPROBE_DAYS.
 *
 * 2. SUBDOMAINS — `auvio.rtbf.be` where `rtbf.be` is what Hunter needs.
 *    NOT normalized blindly: `24flix.vhx.tv` would file "24 Flix" under
 *    vhx.tv, a hosting platform it does not own — the same mistake as
 *    collapsing multi-valued facts. Each one is re-tested with
 *    nameMatchesHost() against the registrable domain, which is the guard
 *    written for exactly this in 0048's companion change. Fails the test →
 *    left alone for a human.
 *
 * Usage:
 *   tsx scripts/fix_account_domains.ts <workspace_id> [--apply]
 *
 * Dry run by default.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { registrableDomain, nameMatchesHost } from '../packages/tools/src/domains.ts';

const SHARED_HOST_MIN = 3;  // a host this many distinct companies claim is not a company domain

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const PAGE = 1000; const out: T[] = [];
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await q(f, f + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

async function main() {
  const WS = process.argv[2];
  const APPLY = process.argv.includes('--apply');
  if (!WS) { console.error('usage: tsx scripts/fix_account_domains.ts <workspace_id> [--apply]'); process.exit(1); }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const accountFacts = await fetchAll<{ subject_entity: string }>((f, t) => sb.from('facts')
    .select('subject_entity').eq('workspace_id', WS)
    .eq('predicate', 'is_a').eq('object_text', 'account').is('supersedes', null).order('id').range(f, t));
  const ids = [...new Set(accountFacts.map((r) => r.subject_entity))];

  type Ent = { id: string; name: string; attributes: Record<string, any> | null; archived_at: string | null };
  const ents: Ent[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from('entities').select('id, name, attributes, archived_at').in('id', ids.slice(i, i + 150));
    ents.push(...((data ?? []) as Ent[]));
  }
  const withDomain = ents.filter((e) => !e.archived_at && e.attributes?.domain);
  console.log(`accounts with a stored domain: ${withDomain.length}`);

  const byHost = new Map<string, Ent[]>();
  for (const e of withDomain) {
    const d = e.attributes!.domain as string;
    if (!byHost.has(d)) byHost.set(d, []);
    byHost.get(d)!.push(e);
  }
  const sharedHosts = new Set([...byHost.entries()].filter(([, v]) => v.length >= SHARED_HOST_MIN).map(([d]) => d));

  const clear: Array<{ e: Ent; why: string }> = [];
  const rewrite: Array<{ e: Ent; from: string; to: string }> = [];
  const leave: Array<{ e: Ent; from: string; to: string }> = [];

  for (const e of withDomain) {
    const host = e.attributes!.domain as string;
    // "Several entities share this host" is NOT enough on its own. YouTube,
    // YouTube Kids and YouTube Premium all sit on youtube.com and that is
    // correct — they are three products of one company, not three companies
    // pointed at someone else's host. The thing that separates those from
    // JOJ Play / EuroSport Player / Hungama Play all filed under
    // play.google.com is whether the entity's own name matches the host. Same
    // guard used everywhere else in this file; caught in dry run before it
    // wiped three valid domains.
    // Test against the REGISTRABLE domain, not the full host. Matching the host
    // lets a common subdomain word carry the match: "JOJ Play" matched
    // play.google.com purely on the label "play". Against google.com it
    // correctly fails, while "YouTube" against youtube.com correctly passes.
    if (sharedHosts.has(host)) {
      if (!nameMatchesHost(e.name, registrableDomain(host))) {
        clear.push({ e, why: `${byHost.get(host)!.length} unrelated companies share this host` });
      }
      continue;  // shared and genuinely theirs: leave it exactly as is
    }
    const reg = registrableDomain(host);
    if (reg === host) continue;
    if (nameMatchesHost(e.name, reg)) rewrite.push({ e, from: host, to: reg });
    else leave.push({ e, from: host, to: reg });
  }

  console.log(`\nCLEAR (aggregator host, let the resolver retry): ${clear.length}`);
  for (const c of clear) console.log(`  ${c.e.name.slice(0, 26).padEnd(28)} ${c.e.attributes!.domain}  (${c.why})`);
  console.log(`\nREWRITE to registrable (name still matches): ${rewrite.length}`);
  for (const r of rewrite) console.log(`  ${r.e.name.slice(0, 26).padEnd(28)} ${r.from}  ->  ${r.to}`);
  console.log(`\nLEAVE ALONE (name does NOT match the registrable domain — probably a hosting platform): ${leave.length}`);
  for (const l of leave) console.log(`  ${l.e.name.slice(0, 26).padEnd(28)} ${l.from}  (would have become ${l.to})`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

  let done = 0, failed = 0;
  for (const { e } of clear) {
    const attrs = { ...(e.attributes ?? {}) };
    delete attrs.domain;
    const { error } = await sb.from('entities').update({ attributes: attrs }).eq('id', e.id);
    if (error) { failed++; console.error(`  FAILED clear ${e.name}: ${error.message}`); } else done++;
  }
  for (const { e, to } of rewrite) {
    const { error } = await sb.from('entities').update({ attributes: { ...(e.attributes ?? {}), domain: to } }).eq('id', e.id);
    if (error) { failed++; console.error(`  FAILED rewrite ${e.name}: ${error.message}`); } else done++;
  }
  console.log(`\nupdated ${done}, failed ${failed}, left alone ${leave.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
