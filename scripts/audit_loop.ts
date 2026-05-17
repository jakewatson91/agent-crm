/**
 * End-to-end loop audit. Read-only.
 *
 * Reports:
 *   1. Pending gates by policy + age
 *   2. Action decisions over last 7d (draft / watch / drop / research / continue)
 *   3. Top 10 entities by icp_total, with their substantive facts
 *   4. Pending drafts in Inbox — body preview + cited facts
 *   5. Sources + last_run_summary
 *
 * Run: pnpm tsx scripts/audit_loop.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const h = (Date.now() - new Date(iso).getTime()) / HOUR;
  if (h < 1) return `${(h * 60).toFixed(0)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

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
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)}…)\n`);

  // ----- 1. Pending gates -----
  console.log('=== PENDING GATES ===');
  const gates = await sb.from('gates')
    .select('id, policy, condition, requested_at, channel_post_id')
    .eq('workspace_id', WS)
    .is('decided_at', null)
    .order('requested_at', { ascending: false });
  if (gates.error) throw gates.error;
  console.log(`total pending: ${gates.data?.length ?? 0}`);
  const byPolicy = new Map<string, number>();
  const ages: number[] = [];
  for (const g of gates.data ?? []) {
    byPolicy.set(g.policy, (byPolicy.get(g.policy) ?? 0) + 1);
    if (g.requested_at) ages.push((Date.now() - new Date(g.requested_at as string).getTime()) / HOUR);
  }
  for (const [p, n] of [...byPolicy.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(28)} ${n}`);
  }
  if (ages.length) {
    ages.sort((a, b) => a - b);
    const med = ages[Math.floor(ages.length / 2)];
    const oldest = ages[ages.length - 1];
    console.log(`  age: median=${med.toFixed(1)}h oldest=${oldest.toFixed(1)}h`);
  }

  // ----- 2. Action decisions over last 7d (from events) -----
  console.log('\n=== ACTION SELECTOR (last 7d, from events) ===');
  const since7 = new Date(Date.now() - 7 * DAY).toISOString();
  const skipEvents = await sb.from('events')
    .select('payload, created_at')
    .eq('workspace_id', WS)
    .eq('action', 'action_selector_skip')
    .gte('created_at', since7)
    .limit(5000);
  const byAction = new Map<string, number>();
  const byPolicy2 = new Map<string, number>();
  for (const e of (skipEvents.data ?? []) as Array<{ payload: { action?: string; policy?: string } }>) {
    const a = e.payload?.action ?? 'unknown';
    const p = e.payload?.policy ?? 'unknown';
    byAction.set(a, (byAction.get(a) ?? 0) + 1);
    byPolicy2.set(p, (byPolicy2.get(p) ?? 0) + 1);
  }
  // Also count state-changing actions (deep_research, drop, draft_outreach) from decision posts
  const decisions = await sb.from('channel_posts')
    .select('body, created_at, channels!inner(workspace_id)')
    .eq('kind', 'decision')
    .eq('channels.workspace_id', WS)
    .gte('created_at', since7)
    .limit(2000);
  for (const d of decisions.data ?? []) {
    const body = (d.body ?? '') as string;
    const m = body.match(/^\[(\w+)\]/);
    if (m) byAction.set(m[1], (byAction.get(m[1]) ?? 0) + 1);
  }
  // Drafts created (touch_draft) imply draft_outreach
  const draftsCount = await sb.from('channel_posts')
    .select('id, channels!inner(workspace_id)', { count: 'exact', head: true })
    .eq('kind', 'touch_draft')
    .eq('channels.workspace_id', WS)
    .gte('created_at', since7);
  if (draftsCount.count) byAction.set('draft_outreach', (byAction.get('draft_outreach') ?? 0) + draftsCount.count);
  console.log('action distribution:');
  for (const [a, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${a.padEnd(20)} ${n}`);
  }
  console.log('top policies (skip reasons):');
  for (const [p, n] of [...byPolicy2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${p.padEnd(28)} ${n}`);
  }

  // ----- 3. Top 10 entities by icp_total + facts -----
  console.log('\n=== TOP 10 BY icp_total ===');
  // pull latest icp_fit (alias of icp_total) per entity via facts table
  const icpFacts = await sb.from('facts')
    .select('subject_entity, object_text, created_at')
    .eq('workspace_id', WS)
    .eq('predicate', 'icp_fit')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (icpFacts.error) {
    console.log(`  error: ${icpFacts.error.message}`);
  } else {
    // dedup to latest per entity
    const latest = new Map<string, { score: number; at: string }>();
    for (const f of icpFacts.data ?? []) {
      const ent = f.subject_entity as string;
      if (!latest.has(ent)) {
        const score = parseFloat((f.object_text ?? '0') as string);
        latest.set(ent, { score, at: f.created_at as string });
      }
    }
    const top = [...latest.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 10);
    if (!top.length) {
      console.log('  (no icp_fit facts)');
    } else {
      const entIds = top.map(([id]) => id);
      const ents = await sb.from('entities').select('id, name, kind').in('id', entIds);
      const entMap = new Map((ents.data ?? []).map((e: any) => [e.id, e]));
      // pull substantive facts for these entities
      const subFacts = await sb.from('facts')
        .select('subject_entity, predicate, object_text, created_at')
        .in('subject_entity', entIds)
        .order('created_at', { ascending: false })
        .limit(500);
      const factsByEnt = new Map<string, Array<{ predicate: string; object_text: string }>>();
      const ADMIN = new Set(['icp_fit', 'icp_fit_breakdown', 'domain', 'contact_lookup_attempted', 'dropped_until']);
      for (const f of subFacts.data ?? []) {
        const pred = f.predicate as string;
        if (ADMIN.has(pred) || pred.startsWith('score_')) continue;
        const arr = factsByEnt.get(f.subject_entity as string) ?? [];
        if (arr.length < 5) arr.push({ predicate: pred, object_text: (f.object_text ?? '') as string });
        factsByEnt.set(f.subject_entity as string, arr);
      }
      for (const [entId, info] of top) {
        const ent = entMap.get(entId) as any;
        const name = ent?.name ?? '?';
        console.log(`  ${info.score.toFixed(2)}  ${name} (${entId.slice(0, 8)}) ${ago(info.at)}`);
        const facts = factsByEnt.get(entId) ?? [];
        if (!facts.length) {
          console.log(`        (no substantive facts!)`);
        } else {
          for (const f of facts) {
            const txt = (f.object_text ?? '').slice(0, 80).replace(/\s+/g, ' ');
            console.log(`        ${f.predicate.padEnd(24)} ${txt}`);
          }
        }
      }
    }
  }

  // ----- 4. Pending drafts in Inbox -----
  console.log('\n=== PENDING DRAFTS (touch_draft kind) ===');
  const drafts = await sb.from('channel_posts')
    .select('id, body, created_at, cites, channel_id, channels!inner(workspace_id, title)')
    .eq('kind', 'touch_draft')
    .eq('channels.workspace_id', WS)
    .gte('created_at', since7)
    .order('created_at', { ascending: false })
    .limit(20);
  if (drafts.error) {
    console.log(`  error: ${drafts.error.message}`);
  } else if (!drafts.data?.length) {
    console.log('  (no drafts in last 7d)');
  } else {
    for (const d of drafts.data) {
      const ch = (d as any).channels;
      const title = (ch?.title ?? '?') as string;
      const cites = (d.cites ?? []) as string[];
      const body = (d.body ?? '') as string;
      const preview = body.length > 240 ? body.slice(0, 240) + '…' : body;
      console.log(`  [${ago(d.created_at as string)}] ${title} cites=${cites.length}`);
      console.log(`    ${preview.replace(/\n/g, '\n    ')}`);
    }
  }

  // ----- 5. Sources -----
  console.log('\n=== SOURCES ===');
  const sources = await sb.from('sources')
    .select('name, connector_type, active, schedule_cron, last_run_at, last_run_summary')
    .eq('workspace_id', WS)
    .order('connector_type');
  if (sources.error) throw sources.error;
  for (const s of sources.data ?? []) {
    const sum = (s.last_run_summary ?? {}) as any;
    console.log(`  [${s.active ? 'ON ' : 'off'}] ${s.connector_type.padEnd(12)} ${(s.name as string).padEnd(28)} cron=${s.schedule_cron ?? '-'} last=${ago(s.last_run_at as string)} sig7d=${sum.signals_7d ?? 0}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
