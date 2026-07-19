// Daily activity report: everything the platform did in the last N hours, per workspace.
// Usage: pnpm report [-- --hours 24] [-- --ws <workspace id or name substring>]
// Core is buildDailyReport() so this can move behind an API route later.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';

type Sb = ReturnType<typeof createServerClient>;

// Per-unit cost assumptions in USD. Override via workspaces.policy.report.pricing
// (same shape). Token rates are per 1M tokens.
const DEFAULT_PRICING = {
  models: {
    'deepseek-v4-flash': { input: 0.14, cached: 0.014, output: 0.28 },
    'deepseek-v4-pro': { input: 0.56, cached: 0.07, output: 1.68 },
  } as Record<string, { input: number; cached: number; output: number }>,
  exa_per_search: 0.005,
  hunter_per_search: 0.049,
};

async function fetchAll<T>(q: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = []; let from = 0; const page = 1000;
  for (;;) {
    const { data, error } = await q(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
    from += page;
  }
  return out;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(2)}`;
const ts = (s: string) => s.slice(5, 16).replace('T', ' ');

export async function buildDailyReport(sb: Sb, wsId: string, wsName: string, hours: number): Promise<string> {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const L: string[] = [];
  const H = (t: string) => L.push('', `## ${t}`, '');

  const events = await fetchAll<{ action: string; created_at: string; payload: any; target_id: string | null }>(
    (f, t) => sb.from('events').select('action, created_at, payload, target_id').eq('workspace_id', wsId).gte('created_at', since).order('created_at', { ascending: true }).range(f, t));
  const by = (action: string) => events.filter((e) => e.action === action);

  const signals = await fetchAll<{ id: string; entity_id: string | null; magnitude: number | null; body_for_embedding: string | null; structured_tags: any; created_at: string }>(
    (f, t) => sb.from('signals').select('id, entity_id, magnitude, body_for_embedding, structured_tags, created_at').eq('workspace_id', wsId).gte('created_at', since).range(f, t));

  const facts = await fetchAll<{ predicate: string; subject_entity: string; object_text: string | null; observed_at: string }>(
    (f, t) => sb.from('facts').select('predicate, subject_entity, object_text, observed_at').eq('workspace_id', wsId).gte('observed_at', since).order('observed_at', { ascending: true }).range(f, t));

  const channels = await fetchAll<{ id: string; account_entity_id: string }>(
    (f, t) => sb.from('channels').select('id, account_entity_id').eq('workspace_id', wsId).range(f, t));
  const accountOfChannel = new Map(channels.map((c) => [c.id, c.account_entity_id]));
  const posts: Array<{ kind: string; created_at: string; body: string | null; channel_id: string }> = [];
  const channelIds = channels.map((c) => c.id);
  for (let i = 0; i < channelIds.length; i += 150) {
    const { data, error } = await sb.from('channel_posts').select('kind, created_at, body, channel_id').in('channel_id', channelIds.slice(i, i + 150)).gte('created_at', since);
    if (error) throw error;
    posts.push(...((data ?? []) as typeof posts));
  }
  posts.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Entity names for everything we mention
  const nameOf = new Map<string, string>();
  const wanted = new Set<string>();
  signals.forEach((s) => s.entity_id && wanted.add(s.entity_id));
  facts.forEach((f) => wanted.add(f.subject_entity));
  events.forEach((e) => e.target_id && wanted.add(e.target_id));
  posts.forEach((p) => wanted.add(accountOfChannel.get(p.channel_id)!));
  const ids = [...wanted].filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('entities').select('id, name').in('id', ids.slice(i, i + 200));
    (data ?? []).forEach((e: any) => nameOf.set(e.id, e.name));
  }
  const N = (id: string | null | undefined) => (id && nameOf.get(id)) ?? (id ?? '?').slice(0, 8);

  const { data: wsRow } = await sb.from('workspaces').select('policy').eq('id', wsId).maybeSingle();
  const policy = (wsRow?.policy ?? {}) as any;
  const pricing = { ...DEFAULT_PRICING, ...(policy.report?.pricing ?? {}), models: { ...DEFAULT_PRICING.models, ...(policy.report?.pricing?.models ?? {}) } };

  L.push(`# ${wsName} — last ${hours}h`, `Window: ${since.slice(0, 16)}Z → now. Pipeline: ${policy.pipeline?.status ? `${policy.pipeline.status} (${policy.pipeline.reason ?? ''})` : 'running'}`);

  // ---- Research ----
  const research = by('research_completed');
  const searches = research.reduce((a, e) => a + (e.payload?.searches ?? 0), 0);
  H(`Research — ${research.length} runs, ${searches} searches, ${fmt(signals.length)} signals`);
  const sigCountByEntity = new Map<string, number>();
  signals.forEach((s) => { const k = N(s.entity_id); sigCountByEntity.set(k, (sigCountByEntity.get(k) ?? 0) + 1); });
  const topAccounts = [...sigCountByEntity].sort((a, b) => b[1] - a[1]).slice(0, 10);
  L.push(`Top accounts: ${topAccounts.map(([k, v]) => `${k} (${v})`).join(', ') || 'none'}`);
  for (const e of by('research_error')) L.push(`ERROR ${ts(e.created_at)}: ${JSON.stringify(e.payload).slice(0, 200)}`);
  const highlights = [...signals].sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0)).slice(0, 5);
  if (highlights.length) L.push('', 'Signal highlights:');
  for (const s of highlights) {
    const tags = s.structured_tags ?? {};
    L.push(`- **${N(s.entity_id)}** (${tags.research_angle ?? tags.signal_source ?? 'signal'}, magnitude ${s.magnitude ?? '?'}) ${tags.url ?? ''}`);
    L.push(`  > ${(s.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  // ---- Domains ----
  const resolved = by('domain_resolved'); const domFailed = by('domain_resolve_failed');
  H(`Domains — ${resolved.length} resolved, ${domFailed.length} refused`);
  for (const e of resolved) L.push(`- ${N(e.target_id)} → ${e.payload?.domain}`);

  // ---- Scoring ----
  const scoreFacts = facts.filter((f) => f.predicate === 'icp_fit');
  const byEntity = new Map<string, typeof scoreFacts>();
  scoreFacts.forEach((f) => { const a = byEntity.get(f.subject_entity) ?? []; a.push(f); byEntity.set(f.subject_entity, a); });
  H(`Scoring — ${scoreFacts.length} account score writes across ${byEntity.size} accounts`);
  // previous value before the window, for delta display
  const prevOf = new Map<string, string>();
  for (const ent of byEntity.keys()) {
    const { data } = await sb.from('facts').select('object_text').eq('workspace_id', wsId).eq('subject_entity', ent).eq('predicate', 'icp_fit').lt('observed_at', since).order('observed_at', { ascending: false }).limit(1);
    if (data?.[0]) prevOf.set(ent, data[0].object_text);
  }
  const movers: Array<{ name: string; prev: string; last: string; delta: number }> = [];
  for (const [ent, rows] of byEntity) {
    const prev = prevOf.get(ent);
    const last = rows[rows.length - 1].object_text ?? '';
    const delta = prev != null ? Math.abs(parseFloat(last) - parseFloat(prev)) : Infinity;
    movers.push({ name: N(ent), prev: prev ?? 'NEW', last, delta: isNaN(delta) ? 0 : delta });
  }
  movers.sort((a, b) => b.delta - a.delta);
  for (const m of movers.slice(0, 15)) L.push(`- ${m.name}: ${m.prev} → ${m.last}`);
  if (movers.length > 15) L.push(`- …and ${movers.length - 15} more (unchanged or small moves)`);

  // ---- Contacts ----
  const pulls = by('contacts_completed');
  const newContacts = facts.filter((f) => f.predicate === 'is_a' && f.object_text === 'contact');
  const contactScores = new Map(facts.filter((f) => f.predicate === 'contact_score').map((f) => [f.subject_entity, f.object_text]));
  const roles = new Map(facts.filter((f) => f.predicate === 'role').map((f) => [f.subject_entity, f.object_text]));
  H(`Contacts — ${pulls.length} pull attempts, ${newContacts.length} new contacts`);
  for (const f of newContacts) L.push(`- ${N(f.subject_entity)} (${roles.get(f.subject_entity) ?? 'role unknown'}, score ${contactScores.get(f.subject_entity) ?? '?'})`);
  const failReasons = new Map<string, number>();
  for (const e of pulls) {
    const s = e.payload?.summary ?? '';
    if (!/new contact/.test(s)) failReasons.set(s, (failReasons.get(s) ?? 0) + 1);
  }
  if (failReasons.size) L.push('', 'Pulls that produced nothing:');
  for (const [reason, count] of [...failReasons].sort((a, b) => b[1] - a[1])) L.push(`- ${count}× ${reason}`);

  // ---- Drafts & sends ----
  const drafts = posts.filter((p) => p.kind === 'touch_draft');
  const sends = posts.filter((p) => p.kind === 'system' && /^Sent →/.test(p.body ?? ''));
  const draftFlags = posts.filter((p) => p.kind === 'system' && /^Draft checks:/.test(p.body ?? ''));
  H(`Drafts — ${drafts.length} written, ${sends.length} sent`);
  for (const p of drafts) {
    L.push(`**${N(accountOfChannel.get(p.channel_id))}** (${ts(p.created_at)})`);
    L.push(`> ${(p.body ?? '').replace(/\n/g, ' ')}`, '');
  }
  for (const p of sends) L.push(`- SENT ${ts(p.created_at)} ${N(accountOfChannel.get(p.channel_id))}: ${p.body}`);
  for (const p of draftFlags) L.push(`- FLAG ${N(accountOfChannel.get(p.channel_id))}: ${(p.body ?? '').replace('Draft checks: ', '')}`);

  // ---- Approvals ----
  const { data: pending } = await sb.from('gates').select('id, policy, condition, requested_at').eq('workspace_id', wsId).is('decision', null).order('requested_at', { ascending: true });
  const { data: decided } = await sb.from('gates').select('id, policy, decision, decided_at, resolution').eq('workspace_id', wsId).gte('decided_at', since);
  H(`Approvals — ${pending?.length ?? 0} waiting, ${decided?.length ?? 0} decided in window`);
  for (const g of pending ?? []) L.push(`- WAITING since ${ts(g.requested_at)} [${g.policy}] ${(g.condition?.body ?? '').replace(/\n/g, ' ').slice(0, 140)}`);
  for (const g of decided ?? []) L.push(`- ${g.decision?.toUpperCase()} ${ts(g.decided_at)} [${g.policy}]${g.resolution?.edited ? ' (edited before send)' : ''}`);

  // ---- Facts ----
  const scoringPreds = /^(icp_fit|score_|contact_score)/;
  const identityPreds = new Set(['is_a', 'email', 'works_at', 'role']);
  const researchFacts = facts.filter((f) => !scoringPreds.test(f.predicate) && !identityPreds.has(f.predicate));
  H(`Facts — ${fmt(facts.length)} total (${researchFacts.length} from research, rest scoring + contact identity)`);
  const pains = researchFacts.filter((f) => f.predicate === 'pain_observed');
  for (const f of pains) L.push(`- PAIN ${N(f.subject_entity)}: ${(f.object_text ?? '').slice(0, 200)}`);
  for (const f of researchFacts.filter((x) => x.predicate !== 'pain_observed').slice(0, 12))
    L.push(`- ${N(f.subject_entity)} ${f.predicate} = ${(f.object_text ?? '').slice(0, 100)}`);
  if (researchFacts.length > 12 + pains.length) L.push(`- …and ${researchFacts.length - 12 - pains.length} more`);

  // ---- Health ----
  const health = events.filter((e) => /health_alert|pause/i.test(e.action));
  if (health.length) {
    H('Health');
    for (const e of health) L.push(`- ${ts(e.created_at)} ${e.action}: ${JSON.stringify(e.payload).slice(0, 160)}`);
  }

  // ---- Spend estimate ----
  H('Spend estimate');
  const metrics = by('agent_run_metrics');
  const byModel = new Map<string, { input: number; cached: number; output: number; runs: number }>();
  for (const e of metrics) {
    const model = String(e.payload?.model ?? 'unknown').split('/').pop()!;
    const m = byModel.get(model) ?? { input: 0, cached: 0, output: 0, runs: 0 };
    m.input += e.payload?.input_tokens ?? 0;
    m.cached += e.payload?.cached_input_tokens ?? 0;
    m.output += e.payload?.output_tokens ?? 0;
    m.runs += 1;
    byModel.set(model, m);
  }
  const behaviors = [...new Set(metrics.map((e) => String(e.payload?.behavior ?? '?')))];
  L.push(`Token metrics cover: ${behaviors.join(', ') || 'none'}. Behaviors without metrics (e.g. scorer, research planner) are NOT counted, so LLM spend is a floor.`);
  let llmTotal = 0;
  for (const [model, m] of byModel) {
    const rate = pricing.models[model];
    const cost = rate ? ((m.input - m.cached) / 1e6) * rate.input + (m.cached / 1e6) * rate.cached + (m.output / 1e6) * rate.output : NaN;
    if (!isNaN(cost)) llmTotal += cost;
    L.push(`- ${model}: ${m.runs} runs, ${fmt(m.input)} in (${fmt(m.cached)} cached) / ${fmt(m.output)} out → ${isNaN(cost) ? 'NO RATE CONFIGURED' : usd(cost)}`);
  }
  const standaloneDomainSearches = Math.max(0, resolved.length + domFailed.length - research.filter((e) => e.payload?.domain_resolved || /domain/.test(e.payload?.summary ?? '')).length);
  const exaSearches = searches + standaloneDomainSearches;
  const exaCost = exaSearches * pricing.exa_per_search;
  const hunterSearches = pulls.filter((e) => /hunter/.test(e.payload?.summary ?? '')).length;
  const hunterCost = hunterSearches * pricing.hunter_per_search;
  L.push(`- Exa: ~${exaSearches} searches → ${usd(exaCost)}`);
  L.push(`- Hunter: ${hunterSearches} domain searches → ${usd(hunterCost)}`);
  L.push(`- **Total: ~${usd(llmTotal + exaCost + hunterCost)}** (unit costs are assumptions; correct them in policy.report.pricing)`);

  // ---- Next 24h ----
  H('Next 24h');
  if (pending?.length) L.push(`- ${pending.length} draft(s) waiting for your approval.`);
  const lastResearch = research[research.length - 1];
  if (lastResearch) L.push(`- Research keeps cycling (${research.length} runs in the window, last ${ts(lastResearch.created_at)}).`);
  const perDay = policy.research?.domain_backfill_per_day ?? 0;
  if (perDay > 0) {
    const accountIds = await entityIdsOfType(sb, wsId, 'account');
    let noDomain = 0;
    for (let i = 0; i < accountIds.length; i += 200) {
      const { data } = await sb.from('entities').select('attributes, archived_at').in('id', accountIds.slice(i, i + 200));
      for (const e of (data ?? []) as any[]) {
        if (!e.archived_at && e.attributes?._candidate !== true && !(typeof e.attributes?.domain === 'string' && e.attributes.domain.length > 0)) noDomain++;
      }
    }
    L.push(`- Domain backfill: ${fmt(noDomain)} accounts still missing a domain, draining ${perDay}/day (~${Math.ceil(noDomain / perDay)} days).`);
  }
  const keyErrors = [...failReasons.keys()].filter((r) => /not set|API key/i.test(r));
  for (const r of keyErrors) L.push(`- BLOCKER: "${r}" — fix the key or contact pulls stay on the fallback provider.`);
  const noDomainPulls = failReasons.get('no domain on account');
  if (noDomainPulls) L.push(`- ${noDomainPulls} account(s) skipped contact pull for lack of a domain; backfill unblocks them.`);
  return L.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const hours = Number(args[args.indexOf('--hours') + 1]) || 24;
  const wsFilter = args.includes('--ws') ? args[args.indexOf('--ws') + 1] : null;
  const sb = createServerClient();
  const { data: workspaces, error } = await sb.from('workspaces').select('id, name');
  if (error) throw error;
  const targets = (workspaces ?? []).filter((w: any) => !wsFilter || w.id === wsFilter || w.name.toLowerCase().includes(wsFilter.toLowerCase()));
  if (!targets.length) { console.error(`No workspace matches "${wsFilter}"`); process.exit(1); }
  for (const w of targets) {
    // Skip silent workspaces when reporting on all
    if (!wsFilter) {
      const { count } = await sb.from('events').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id).gte('created_at', new Date(Date.now() - hours * 3600e3).toISOString());
      if (!count) continue;
    }
    console.log(await buildDailyReport(sb, w.id, w.name, hours));
    console.log('\n---\n');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
