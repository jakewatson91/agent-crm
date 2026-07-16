/**
 * Bulk search-based domain resolution: set attributes.domain on the best-scored
 * accounts that lack one, via resolveDomainViaSearch (one Exa "official website"
 * search per account, name-match + corroboration guard, never overwrites).
 *
 * The research runner does the same thing one account per tick; this tool front
 * loads the book so own-site research angles, ATS probes, and contact pulls
 * unlock now instead of over weeks of dispatcher picks.
 *
 * Selection: accounts ordered by current icp_fit score descending. "Current" =
 * the fact row not pointed to by any other row's supersedes (NOT
 * .is('supersedes', null), which returns the stale original).
 *
 * Skips: accounts that already have a domain; accounts with a
 * domain_resolve_failed marker in the last 30 days (the resolver's cooldown);
 * any workspace paused scope=all (respects the operator's pause, no exceptions).
 *
 * After apply: accounts that just gained a domain and carry a cached
 * attributes.ats.provider === 'none' hint get that hint dropped, so the next
 * daily ATS run re-probes immediately instead of waiting out the 30-day
 * reprobe window. The hint was recorded when the entity had no domain.
 *
 * Usage: pnpm exec tsx scripts/_resolve_domains_bulk.ts <workspace-id-prefix> [--top N] [apply]
 * Without "apply" it is a dry run: no writes, no markers.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { resolveDomainViaSearch } from '../packages/tools/src/domains.ts';
import { fetchAll } from '../packages/tools/src/paginate.ts';
import { getPolicy, resolveEnvVar, type WorkspacePolicy } from '../packages/tools/src/policy.ts';
import { ACTIVITY_MARKERS } from '../packages/tools/src/activity_markers.ts';

const COOLDOWN_DAYS = 30;

const args = process.argv.slice(2);
const APPLY = args.includes('apply');
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) : 200;
const prefix = args.find((a) => a !== 'apply' && a !== '--top' && a !== String(TOP));

async function main() {
  if (!prefix || !Number.isFinite(TOP) || TOP < 1) {
    console.error('Usage: pnpm exec tsx scripts/_resolve_domains_bulk.ts <workspace-id-prefix> [--top N] [apply]');
    process.exit(1);
  }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data: wss, error: wsErr } = await sb.from('workspaces').select('id, name, policy');
  if (wsErr) throw wsErr;
  const matches = (wss ?? []).filter((w) => (w.id as string).startsWith(prefix));
  if (matches.length !== 1) {
    console.error(`workspace prefix "${prefix}" matched ${matches.length} workspaces; need exactly 1`);
    process.exit(1);
  }
  const ws = matches[0]!;
  const rawPolicy = (ws.policy ?? {}) as WorkspacePolicy;
  const pipe = rawPolicy.pipeline;
  if (pipe?.state === 'paused' && (pipe.scope ?? 'all') === 'all') {
    console.error(`${ws.name} (${(ws.id as string).slice(0, 8)}) is paused scope=all. Refusing to run a bulk operation against a paused workspace.`);
    process.exit(1);
  }

  const policy = await getPolicy(sb, ws.id as string);
  const exaKey = resolveEnvVar(policy, 'EXA_API_KEY');
  if (!exaKey) {
    console.error('EXA_API_KEY not set (workspace policy.env or process env)');
    process.exit(1);
  }

  // Current icp_fit score per account (supersedes-chain aware).
  interface FactRow { id: string; subject_entity: string; object_text: string | null; observed_at: string | null; supersedes: string | null }
  const factRows = await fetchAll<FactRow>((from, to) =>
    sb.from('facts').select('id, subject_entity, object_text, observed_at, supersedes')
      .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
      .order('id', { ascending: true }).range(from, to));
  const pointedTo = new Set(factRows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const scoreByEntity = new Map<string, { score: number; observed_at: string }>();
  for (const r of factRows) {
    if (pointedTo.has(r.id)) continue;
    const score = Number(r.object_text);
    if (!Number.isFinite(score)) continue;
    const at = r.observed_at ?? '';
    const prev = scoreByEntity.get(r.subject_entity);
    if (!prev || at > prev.observed_at) scoreByEntity.set(r.subject_entity, { score, observed_at: at });
  }
  console.log(`${ws.name} (${(ws.id as string).slice(0, 8)}): ${scoreByEntity.size} scored accounts`);

  // Entity rows for the scored accounts; keep the ones without a domain.
  const ids = [...scoreByEntity.keys()];
  interface EntRow { id: string; name: string; attributes: Record<string, unknown> | null }
  const entities: EntRow[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb.from('entities').select('id, name, attributes').in('id', ids.slice(i, i + 150));
    if (error) throw error;
    entities.push(...((data ?? []) as EntRow[]));
  }
  const noDomain = entities
    .filter((e) => {
      const d = e.attributes?.domain;
      return !(typeof d === 'string' && d.length > 0);
    })
    .sort((a, b) => scoreByEntity.get(b.id)!.score - scoreByEntity.get(a.id)!.score);
  console.log(`${noDomain.length} scored accounts lack a domain; taking top ${Math.min(TOP, noDomain.length)}`);
  const picked = noDomain.slice(0, TOP);

  // Cooldown: skip accounts a previous run already failed on (last 30 days).
  const since = new Date(Date.now() - COOLDOWN_DAYS * 86400 * 1000).toISOString();
  const cooled = new Set<string>();
  for (let i = 0; i < picked.length; i += 150) {
    const chunk = picked.slice(i, i + 150).map((e) => e.id);
    const { data, error } = await sb.from('events').select('target_id')
      .eq('workspace_id', ws.id).eq('target_kind', 'entity')
      .eq('action', ACTIVITY_MARKERS.DOMAIN_RESOLVE_FAILED)
      .in('target_id', chunk).gte('created_at', since);
    if (error) throw error;
    for (const r of data ?? []) cooled.add(r.target_id as string);
  }

  const counts = { attempted: 0, resolved: 0, no_match: 0, skipped_cooldown: 0, search_errors: 0, ats_hints_dropped: 0 };
  let consecutiveErrors = 0;
  for (const e of picked) {
    const score = scoreByEntity.get(e.id)!.score.toFixed(2);
    if (cooled.has(e.id)) {
      counts.skipped_cooldown++;
      console.log(`COOLDOWN [${score}] ${e.name}: failed within ${COOLDOWN_DAYS}d, skipping`);
      continue;
    }
    counts.attempted++;
    const r = await resolveDomainViaSearch(sb, {
      workspace_id: ws.id as string,
      entity_id: e.id,
      entity_name: e.name,
      exa_api_key: exaKey,
      apply: APPLY,
    });

    if (r.status === 'search_error') {
      counts.search_errors++;
      consecutiveErrors++;
      console.log(`ERROR [${score}] ${e.name}: ${r.error}`);
      if (consecutiveErrors >= 3) {
        console.error('3 consecutive search errors (credit wall / outage?). Stopping.');
        break;
      }
      continue;
    }
    consecutiveErrors = 0;

    if (r.status === 'resolved') {
      counts.resolved++;
      console.log(`${APPLY ? 'SET' : 'WOULD SET'} [${score}] ${e.name} -> ${r.domain}`);
      for (const u of r.evidence_urls) console.log(`    evidence: ${u}`);
      for (const rej of r.rejections) console.log(`    outranked: ${rej.host ?? rej.url} (${rej.reason})`);
      // Stale "no ATS board" hint: recorded when the entity had no domain, so
      // it says nothing now. Drop it so the daily ATS run re-probes.
      if (APPLY) {
        const { data: ent } = await sb.from('entities').select('attributes').eq('id', e.id).single();
        const attrs = { ...((ent?.attributes ?? {}) as Record<string, unknown>) };
        const ats = attrs.ats as { provider?: string } | undefined;
        if (ats?.provider === 'none') {
          delete attrs.ats;
          const { error } = await sb.from('entities').update({ attributes: attrs }).eq('id', e.id);
          if (error) console.log(`    ats hint drop FAILED: ${error.message}`);
          else { counts.ats_hints_dropped++; console.log('    dropped stale ats provider=none hint (re-probe next ATS run)'); }
        }
      }
    } else if (r.status === 'no_match') {
      counts.no_match++;
      console.log(`NO MATCH [${score}] ${e.name}: nothing passed the guard`);
      for (const rej of r.rejections) console.log(`    reject: ${rej.host ?? rej.url} (${rej.reason})`);
    } else {
      // already_has_domain: raced with the runner between selection and now.
      console.log(`SKIP [${score}] ${e.name}: already has domain ${r.domain}`);
    }
  }

  const hitRate = counts.attempted ? Math.round((counts.resolved / counts.attempted) * 100) : 0;
  console.log(`\nSummary: ${counts.resolved}/${counts.attempted} resolved (${hitRate}%), ` +
    `${counts.no_match} no-match, ${counts.skipped_cooldown} on cooldown, ` +
    `${counts.search_errors} search errors, ${counts.ats_hints_dropped} stale ATS hints dropped`);
  if (!APPLY) console.log('Dry run. Re-run with "apply" to execute.');
}

main().catch((e) => { console.error(e); process.exit(1); });
