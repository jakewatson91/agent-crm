import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function main() {
  // 1. pipeline pause status
  const w = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  const policy = (w.data?.policy ?? {}) as Record<string, any>;
  console.log('── pipeline status:', JSON.stringify(policy.pipeline ?? null));
  console.log('── enrichment cfg:', JSON.stringify(policy.enrichment ?? null));
  console.log('── research cfg keys:', JSON.stringify({ ...policy.research, strategy: `(${(policy.research?.strategy ?? []).length} angles)` }));
  console.log('── routing cfg:', JSON.stringify(policy.routing ?? null));
  console.log('── contacts cfg:', JSON.stringify(policy.contacts ?? null));

  // 2. facts created in last 24h, by predicate
  const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();
  const facts = await sb.from('facts')
    .select('id, predicate, subject_entity, object_text, created_at')
    .eq('workspace_id', WS)
    .gte('created_at', since24)
    .order('created_at', { ascending: false })
    .limit(1000);
  const byPred = new Map<string, number>();
  const entIds = new Set<string>();
  for (const f of facts.data ?? []) {
    byPred.set(f.predicate, (byPred.get(f.predicate) ?? 0) + 1);
    if (!f.predicate.startsWith('score_')) entIds.add(f.subject_entity);
  }
  console.log(`\n── facts last 24h: ${facts.data?.length} across ${entIds.size} entities (non-score)`);
  for (const [p, n] of [...byPred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`   ${String(n).padStart(4)}  ${p}`);

  // 3. the 23 drafts from last 24h — sample 3 w/ entity + body preview
  const drafts = await sb.from('channel_posts')
    .select('id, body, structured, created_at, channel_id, channels!inner(workspace_id)')
    .eq('channels.workspace_id', WS)
    .eq('kind', 'touch_draft')
    .gte('created_at', since24)
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`\n── touch_drafts last 24h: ${drafts.data?.length}`);
  for (const d of (drafts.data ?? []).slice(0, 4)) {
    const s = (d.structured ?? {}) as Record<string, any>;
    console.log(`   [${d.created_at}] entity=${s.entity_name ?? s.entity_id ?? '?'} to=${s.to_email ?? 'null'}`);
    console.log(`     subj: ${s.subject ?? '(none)'}`);
    console.log(`     body: ${String(d.body ?? '').slice(0, 220).replace(/\n/g, ' / ')}`);
  }

  // 4. top-scored accounts right now (current score_total)
  const sf = await sb.from('facts')
    .select('id, subject_entity, predicate, object_text, supersedes')
    .eq('workspace_id', WS)
    .eq('predicate', 'score_total')
    .limit(5000);
  const pointed = new Set((sf.data ?? []).map((r: any) => r.supersedes).filter(Boolean));
  const cur = (sf.data ?? []).filter((r: any) => !pointed.has(r.id));
  const scored = cur.map((r: any) => ({ e: r.subject_entity, v: parseFloat(r.object_text) })).filter((x) => Number.isFinite(x.v));
  scored.sort((a, b) => b.v - a.v);
  const topIds = scored.slice(0, 12).map((x) => x.e);
  const ents = await sb.from('entities').select('id, name, attributes').in('id', topIds);
  const nameById = new Map((ents.data ?? []).map((e: any) => [e.id, { name: e.name, domain: e.attributes?.domain ?? null }]));
  console.log(`\n── top 12 accounts by current score_total (${scored.length} scored total):`);
  for (const s of scored.slice(0, 12)) {
    const m = nameById.get(s.e) as any;
    console.log(`   ${s.v.toFixed(2)}  ${m?.name ?? s.e}  domain=${m?.domain ?? 'NULL'}`);
  }

  // 5. research_result signals in last 24h: how many entities, and do their entities have domains?
  const rsig = await sb.from('signals')
    .select('entity_id, structured_tags')
    .eq('workspace_id', WS)
    .eq('type', 'research_result')
    .gte('observed_at', since24)
    .limit(1000);
  const rents = new Map<string, number>();
  for (const s of rsig.data ?? []) rents.set(s.entity_id, (rents.get(s.entity_id) ?? 0) + 1);
  const rentEnts = await sb.from('entities').select('id, name, attributes').in('id', [...rents.keys()]);
  console.log(`\n── research_result last 24h: ${rsig.data?.length} signals across ${rents.size} entities:`);
  for (const e of (rentEnts.data ?? []) as any[]) {
    console.log(`   ${String(rents.get(e.id)).padStart(3)}  ${e.name}  domain=${e.attributes?.domain ?? 'NULL'}`);
  }

  // 6. pending gates
  const gates = await sb.from('approvals').select('id, kind, status, created_at, payload').eq('workspace_id', WS).eq('status', 'pending').order('created_at', { ascending: false }).limit(30);
  console.log(`\n── pending approvals: ${gates.data?.length}`);
  for (const g of (gates.data ?? []).slice(0, 5)) {
    const p = (g.payload ?? {}) as Record<string, any>;
    console.log(`   [${g.created_at}] kind=${g.kind} entity=${p.entity_name ?? p.entity_id ?? '?'} subj=${(p.subject ?? '').slice(0, 60)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
