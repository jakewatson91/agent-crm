/**
 * End-to-end verification of the value-aligned send loop. Read-only.
 *
 *   pnpm tsx scripts/verify_loop.ts
 *
 * Walks the demo workspace's top entities through:
 *   1. hasValueAlignedFact match against the workspace's drafter.value_themes
 *   2. selectAction's draft / watch / drop / continue routing with current facts
 *   3. dropped_until and outreach_cooldown_until guards
 *
 * No prod writes. Output is what a real agent_run would do today if a signal
 * arrived for each entity right now.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { hasValueAlignedFact, selectAction, getPolicy, type ValueTheme } from '@agent-crm/tools';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const ws = await sb.from('workspaces')
    .select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;
  const policy = await getPolicy(sb, WS);
  const themes = (policy.drafter?.value_themes ?? []) as ValueTheme[];
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)})`);
  console.log(`value_themes installed: ${themes.length}`);
  for (const t of themes) console.log(`  ${t.name.padEnd(20)} ${t.pattern.slice(0, 80)}`);
  console.log();

  // Pull top 20 by icp_fit.
  const icp = await sb.from('facts')
    .select('subject_entity, object_text, observed_at')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').is('supersedes', null)
    .limit(2000);
  const scoreMap = new Map<string, number>();
  for (const f of icp.data ?? []) {
    const v = parseFloat((f.object_text ?? '0') as string);
    if (Number.isFinite(v)) scoreMap.set(f.subject_entity as string, v);
  }
  const topIds = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id]) => id);

  // Pull all facts for these entities, plus entity names.
  const [ents, facts] = await Promise.all([
    sb.from('entities').select('id, name').in('id', topIds),
    sb.from('facts').select('subject_entity, predicate, object_text, observed_at')
      .in('subject_entity', topIds).is('supersedes', null).limit(10000),
  ]);
  const entById = new Map((ents.data ?? []).map((e: any) => [e.id, e.name as string]));

  // Per-entity collections
  const ADMIN = new Set([
    'icp_fit', 'icp_fit_breakdown', 'domain', 'contact_lookup_attempted',
    'dropped_until', 'outreach_cooldown_until', 'last_outreach_at',
    'research_triggered', 'research_completed',
    'no_reply_marked', 'outreach_rejected_at', 'replied_at',
    'query', 'intent', 'item_url', 'published_at', 'matched_alias',
    'topic', 'source_url', 'source_title',
  ]);
  const subFactsByEnt = new Map<string, Array<{ predicate: string; object_text: string | null }>>();
  const scoreFactsByEnt = new Map<string, Record<string, number>>();
  const dropByEnt = new Map<string, string>();
  const coolByEnt = new Map<string, string>();
  for (const f of (facts.data ?? []) as Array<{ subject_entity: string; predicate: string; object_text: string | null }>) {
    const ent = f.subject_entity;
    if (f.predicate === 'dropped_until' && f.object_text) dropByEnt.set(ent, f.object_text);
    else if (f.predicate === 'outreach_cooldown_until' && f.object_text) coolByEnt.set(ent, f.object_text);
    else if (f.predicate.startsWith('score_')) {
      const sf = scoreFactsByEnt.get(ent) ?? {};
      const v = parseFloat((f.object_text ?? '0') as string);
      if (Number.isFinite(v)) sf[f.predicate] = v;
      scoreFactsByEnt.set(ent, sf);
    } else if (!ADMIN.has(f.predicate)) {
      const arr = subFactsByEnt.get(ent) ?? [];
      arr.push({ predicate: f.predicate, object_text: f.object_text });
      subFactsByEnt.set(ent, arr);
    }
  }

  console.log('=== ACTION ROUTING (synthetic, no writes) ===');
  let drafted = 0, watched = 0, dropped = 0, cooled = 0, suppressed = 0, otherK = 0;
  for (const id of topIds) {
    const name = entById.get(id) ?? '?';
    const total = scoreMap.get(id) ?? 0;
    const sf = scoreFactsByEnt.get(id) ?? {};
    const breakdown = {
      industry_match: sf.score_industry_match ?? 0,
      stage_match: sf.score_stage_match ?? 0,
      signal_strength: sf.score_signal_strength ?? 0,
      evidence_depth: sf.score_evidence_depth ?? 0,
      recency: sf.score_recency ?? 0,
      graph_proximity: sf.score_graph_proximity ?? 0,
      rrf_prefilter: 0,
    };
    const substantive = subFactsByEnt.get(id) ?? [];
    const match = hasValueAlignedFact(substantive, themes);
    const decision = selectAction({
      workspace_id: WS,
      entity_id: id,
      breakdown,
      icp_total: total,
      recent_draft_at: null,
      recent_research_at: null,
      dropped_until: dropByEnt.get(id) ?? null,
      cooldown_until: coolByEnt.get(id) ?? null,
      facts: substantive,
      value_themes: themes,
    });
    if (decision.action === 'draft_outreach') drafted++;
    else if (decision.action === 'watch_only') watched++;
    else if (decision.action === 'drop') dropped++;
    else if (decision.policy === 'outreach_cooldown_active') cooled++;
    else if (decision.policy === 'dropped_suppressed') suppressed++;
    else otherK++;
    const tag = decision.action.padEnd(14);
    const themePart = (decision as any).matched_theme ? ` theme=${(decision as any).matched_theme}` : '';
    console.log(`  ${total.toFixed(2)} ${tag} ${name.padEnd(28)} ${decision.policy}${themePart}`);
    if (decision.action === 'draft_outreach') {
      console.log(`      evidence: ${(decision as any).matched_evidence ?? '(unknown)'}`);
    } else if (decision.policy === 'no_value_aligned_signal') {
      console.log(`      no_theme_match. facts: ${substantive.slice(0, 3).map((f) => `${f.predicate}=${(f.object_text ?? '').slice(0, 40)}`).join(' | ')}`);
    }
  }
  console.log(`\nsummary: draft=${drafted} watch=${watched} drop=${dropped} cooldown=${cooled} suppressed=${suppressed} other=${otherK}`);

  console.log('\n=== ACCEPTANCE CHECKS ===');
  const c1 = drafted >= 1;
  const c2 = watched >= 1; // some entity should be filtered by the value gate or fail another threshold
  console.log(`  [${c1 ? 'OK' : 'FAIL'}] at least 1 entity routes to draft_outreach`);
  console.log(`  [${c2 ? 'OK' : 'FAIL'}] at least 1 entity routes to watch_only`);
}

main().catch((e) => { console.error(e); process.exit(1); });
