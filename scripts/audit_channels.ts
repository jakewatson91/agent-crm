/**
 * Per-channel content inventory.
 * Outputs: signals/facts/posts counts, source diversity, post-kind breakdown,
 * sample of each kind, redundancy heuristics, warming-stage classification.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';

interface ChannelReport {
  channel_id: string;
  entity_id: string;
  name: string;
  source: string;             // yc / web / seed / unknown
  industry: string | null;
  domain: string | null;
  signal_count: number;
  signal_types: Record<string, number>;
  signal_sources: Record<string, number>;
  fact_count: number;
  fact_predicates: Record<string, number>;
  active_fact_count: number;
  post_count: number;
  post_kinds: Record<string, number>;
  unique_post_authors: string[];
  oldest_signal_at: string | null;
  newest_activity_at: string | null;
  redundancy_score: number;   // 0 = unique, 1 = highly redundant
  redundancy_notes: string[];
  warming_stage: string;
  recent_signals: Array<{ type: string; body: string; signal_source: string; observed_at: string }>;
  recent_posts: Array<{ kind: string; author: string; body: string; cites: number; created_at: string }>;
  recent_facts: Array<{ predicate: string; object_text: string; confidence: number }>;
}

function classifyStage(r: { signal_count: number; fact_count: number; post_kinds: Record<string, number> }): string {
  const hasDrafts = (r.post_kinds.touch_draft ?? 0) > 0;
  const hasGates = (r.post_kinds.gate_request ?? 0) > 0;
  const hasClaims = (r.post_kinds.claim ?? 0) > 0;
  if (r.signal_count === 0 && r.fact_count <= 5) return 'cold (no signals, just seed facts)';
  if (r.signal_count > 0 && r.fact_count === 0) return 'discovered (signals arrived, no enrichment yet)';
  if (r.signal_count > 0 && r.fact_count > 0 && !hasClaims) return 'enriched (facts asserted, no scoring claim posted)';
  if (hasClaims && !hasDrafts && !hasGates) return 'scored (claims posted, no draft attempted)';
  if (hasGates && !hasDrafts) return 'gated (drafter blocked; needs review or more facts)';
  if (hasDrafts) return 'draft ready (touch_draft posted, awaiting human review)';
  return 'unknown';
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id, name').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
  const WS = ws.data!.id;

  const channels = await sb.from('channels').select('id, title, account_entity_id').eq('workspace_id', WS);
  const reports: ChannelReport[] = [];

  for (const ch of channels.data ?? []) {
    const ent = await sb.from('entities').select('id, name, attributes').eq('id', ch.account_entity_id).single();
    const attrs = (ent.data!.attributes ?? {}) as Record<string, unknown>;

    const [sigs, facts, posts] = await Promise.all([
      sb.from('signals').select('type, body_for_embedding, structured_tags, observed_at').eq('entity_id', ent.data!.id).order('observed_at', { ascending: false }).limit(100),
      sb.from('facts').select('id, predicate, object_text, confidence, observed_at, supersedes').eq('subject_entity', ent.data!.id).limit(200),
      sb.from('channel_posts').select('kind, body, cites, author_id, created_at').eq('channel_id', ch.id).order('created_at', { ascending: false }).limit(50),
    ]);

    const sigTypes: Record<string, number> = {};
    const sigSources: Record<string, number> = {};
    for (const s of sigs.data ?? []) {
      sigTypes[s.type as string] = (sigTypes[s.type as string] ?? 0) + 1;
      const src = ((s.structured_tags as Record<string, unknown> | null)?.signal_source as string) ?? 'unknown';
      sigSources[src] = (sigSources[src] ?? 0) + 1;
    }

    const factPredicates: Record<string, number> = {};
    const supersededIds = new Set((facts.data ?? []).map((f) => f.supersedes).filter((x): x is string => !!x));
    let activeFactCount = 0;
    for (const f of facts.data ?? []) {
      factPredicates[f.predicate as string] = (factPredicates[f.predicate as string] ?? 0) + 1;
      if (!supersededIds.has(f.id as string)) activeFactCount++;
    }

    const postKinds: Record<string, number> = {};
    const authorSet = new Set<string>();
    for (const p of posts.data ?? []) {
      postKinds[p.kind as string] = (postKinds[p.kind as string] ?? 0) + 1;
      authorSet.add(p.author_id as string);
    }

    // Redundancy heuristic: how similar are post bodies to each other?
    // Use first-200-char prefixes as a cheap dedup signature.
    const bodies = (posts.data ?? []).map((p) => (p.body as string).slice(0, 200).toLowerCase());
    const uniquePrefixes = new Set(bodies);
    const redundancyScore = bodies.length > 0 ? 1 - (uniquePrefixes.size / bodies.length) : 0;
    const redundancyNotes: string[] = [];
    if (redundancyScore > 0.5) redundancyNotes.push(`${(redundancyScore * 100).toFixed(0)}% of posts have duplicate prefixes — likely repeated test runs`);
    if ((postKinds.touch_draft ?? 0) > 3) redundancyNotes.push(`${postKinds.touch_draft} touch_drafts on one channel — drafter fired repeatedly without human action`);
    if ((sigTypes.careers_page_diff ?? 0) > 2) redundancyNotes.push(`${sigTypes.careers_page_diff} careers_page_diff signals — likely repeated injections`);

    const newestActivity = [
      ...((sigs.data ?? []).map((s) => s.observed_at as string)),
      ...((facts.data ?? []).map((f) => f.observed_at as string)),
      ...((posts.data ?? []).map((p) => p.created_at as string)),
    ].sort().reverse()[0] ?? null;

    const oldestSignal = ((sigs.data ?? []).map((s) => s.observed_at as string)).sort()[0] ?? null;

    // Determine origin
    let source = 'unknown';
    const discoveredVia = attrs._discovered_via ?? attrs.discovered_via; // _-prefixed since portability migration 0036
    if (discoveredVia === 'web' || discoveredVia === 'exa') source = String(discoveredVia);
    else if (attrs.yc_batch) source = 'yc';
    else source = 'seed';

    const r: ChannelReport = {
      channel_id: ch.id as string,
      entity_id: ent.data!.id,
      name: ent.data!.name,
      source,
      industry: (attrs.industry as string) ?? null,
      domain: (attrs.domain as string) ?? null,
      signal_count: sigs.data?.length ?? 0,
      signal_types: sigTypes,
      signal_sources: sigSources,
      fact_count: facts.data?.length ?? 0,
      fact_predicates: factPredicates,
      active_fact_count: activeFactCount,
      post_count: posts.data?.length ?? 0,
      post_kinds: postKinds,
      unique_post_authors: [...authorSet],
      oldest_signal_at: oldestSignal,
      newest_activity_at: newestActivity,
      redundancy_score: redundancyScore,
      redundancy_notes: redundancyNotes,
      warming_stage: classifyStage({ signal_count: sigs.data?.length ?? 0, fact_count: facts.data?.length ?? 0, post_kinds: postKinds }),
      recent_signals: (sigs.data ?? []).slice(0, 3).map((s) => ({
        type: s.type as string,
        body: (s.body_for_embedding as string ?? '').slice(0, 200),
        signal_source: ((s.structured_tags as Record<string, unknown> | null)?.signal_source as string) ?? 'unknown',
        observed_at: s.observed_at as string,
      })),
      recent_posts: (posts.data ?? []).slice(0, 3).map((p) => ({
        kind: p.kind as string,
        author: p.author_id as string,
        body: (p.body as string).slice(0, 280),
        cites: ((p.cites as string[]) ?? []).length,
        created_at: p.created_at as string,
      })),
      recent_facts: (facts.data ?? []).filter((f) => !supersededIds.has(f.id as string)).slice(0, 8).map((f) => ({
        predicate: f.predicate as string,
        object_text: (f.object_text as string) ?? '',
        confidence: f.confidence as number,
      })),
    };
    reports.push(r);
  }

  reports.sort((a, b) => (Date.parse(b.newest_activity_at ?? '1970') - Date.parse(a.newest_activity_at ?? '1970')));

  // Print summary table
  console.log(`\n=== ${reports.length} channels in workspace ===\n`);
  console.log('source     industry      sigs facts active posts kinds                                          stage');
  console.log('---------- ------------- ---- ----- ------ ----- ---------------------------------------------- -------------------------');
  for (const r of reports) {
    const kindStr = Object.entries(r.post_kinds).map(([k, n]) => `${k}=${n}`).join(',') || '-';
    console.log(
      `${r.source.padEnd(10)} ${(r.industry ?? '-').slice(0,13).padEnd(13)} ${String(r.signal_count).padStart(4)} ${String(r.fact_count).padStart(5)} ${String(r.active_fact_count).padStart(6)} ${String(r.post_count).padStart(5)} ${kindStr.slice(0,46).padEnd(46)} ${r.warming_stage} ::${r.name}`
    );
  }

  writeFileSync('/tmp/audit_channels.json', JSON.stringify(reports, null, 2));
  console.log('\nfull dump → /tmp/audit_channels.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
