import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';

const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const n = 1000;
  for (;;) { const { data, error } = await q(f, f + n - 1); if (error) throw error; const r = (data ?? []) as T[]; out.push(...r); if (r.length < n) break; f += n; }
  return out;
}

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - 26 * 3600e3).toISOString();

  // 1. event action histogram, Sudden, last 26h
  const evts = await fetchAll<{ action: string; actor_id: string; created_at: string; payload: any }>(
    (f, t) => sb.from('events').select('action, actor_id, created_at, payload').eq('workspace_id', SUDDEN).gte('created_at', since).order('created_at', { ascending: false }).range(f, t));
  const hist = new Map<string, number>();
  for (const e of evts) hist.set(e.action, (hist.get(e.action) ?? 0) + 1);
  console.log(`SUDDEN events since ${since} (${evts.length} total):`);
  for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${v}`);

  // errors / pauses / alerts in the window
  const interesting = evts.filter((e) => /error|pause|alert|fail|wall/i.test(e.action));
  console.log(`\nerror/pause/alert events: ${interesting.length}`);
  for (const e of interesting.slice(0, 15)) console.log(`  ${e.created_at.slice(0, 16)} ${e.action} ${JSON.stringify(e.payload)?.slice(0, 220)}`);

  // 2. domain backfill progress
  const acctIds = await entityIdsOfType(sb, SUDDEN, 'account');
  let archived = 0, candidate = 0, hasDomain = 0, noDomain = 0;
  for (let i = 0; i < acctIds.length; i += 200) {
    const { data, error } = await sb.from('entities').select('id, attributes, archived_at').in('id', acctIds.slice(i, i + 200));
    if (error) throw error;
    for (const e of (data ?? []) as any[]) {
      if (e.archived_at) { archived++; continue; }
      if (e.attributes?._candidate === true) { candidate++; continue; }
      if (typeof e.attributes?.domain === 'string' && e.attributes.domain.length > 0) { hasDomain++; continue; }
      noDomain++;
    }
  }
  console.log(`\ndomains: accounts=${acctIds.length} archived=${archived} candidate=${candidate} hasDomain=${hasDomain} noDomain=${noDomain}  (yesterday: 215 with, 1746 without)`);

  // 3. icp_fit score histogram (current facts only) + recency
  const scores = await fetchAll<{ subject_entity: string; object_text: string; observed_at: string }>(
    (f, t) => sb.from('facts').select('subject_entity, object_text, observed_at').eq('workspace_id', SUDDEN).eq('predicate', 'icp_fit').is('supersedes', null).order('id').range(f, t));
  const acctSet = new Set(acctIds);
  const acctScores = scores.filter((s) => acctSet.has(s.subject_entity));
  const buckets = new Map<string, number>();
  let last24 = 0;
  for (const s of acctScores) {
    const v = parseFloat(s.object_text);
    const b = Number.isFinite(v) ? (Math.min(Math.floor(v * 10), 9) / 10).toFixed(1) : 'NaN';
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
    if (s.observed_at >= since) last24++;
  }
  console.log(`\nicp_fit (account facts, current): n=${acctScores.length}, scored in last 26h=${last24}`);
  for (const [k, v] of [...buckets].sort()) console.log(`  [${k}) ${String(v).padStart(5)}  ${'#'.repeat(Math.round((v / acctScores.length) * 60))}`);

  // 4. signals created last 26h, by source tag
  const sigs = await fetchAll<{ structured_tags: any; created_at: string }>(
    (f, t) => sb.from('signals').select('structured_tags, created_at').eq('workspace_id', SUDDEN).gte('created_at', since).order('created_at', { ascending: false }).range(f, t));
  const srcHist = new Map<string, number>();
  for (const s of sigs) {
    const tags = s.structured_tags ?? {};
    const key = String(tags.angle ?? tags.source_id ?? tags.kind ?? 'unknown');
    srcHist.set(key, (srcHist.get(key) ?? 0) + 1);
  }
  console.log(`\nsignals last 26h: ${sigs.length}`);
  for (const [k, v] of [...srcHist].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(30)} ${v}`);

  // 5. drafts + pending gates
  const { data: drafts } = await sb.from('channel_posts').select('id, kind, created_at, body').eq('workspace_id', SUDDEN).eq('kind', 'draft').gte('created_at', since).order('created_at', { ascending: false });
  console.log(`\ndrafts last 26h: ${drafts?.length ?? 0}`);
  for (const d of drafts ?? []) console.log(`  ${d.created_at.slice(0, 16)}  ${d.body?.slice(0, 100).replace(/\n/g, ' ')}`);
  const { data: gates } = await sb.from('gates').select('id, created_at').eq('workspace_id', SUDDEN).is('decided_at', null);
  console.log(`pending approvals: ${gates?.length ?? 0}`);

  // 6. pipeline status
  const { data: ws } = await sb.from('workspaces').select('policy').eq('id', SUDDEN).single();
  console.log('\npipeline:', JSON.stringify((ws!.policy as any).pipeline ?? null));
}

main().catch((e) => { console.error(e); process.exit(1); });
