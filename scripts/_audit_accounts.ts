/**
 * Read-only audit: where did the workspace's account entities come from, and
 * how many are low-value? Breaks down by creating source, name quality,
 * dedup collisions, and emptiness.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

// Mirror of the junk-name heuristic used at display time in the entities API.
const ARTICLE_SUFFIX = /\s(story|guide|tips|trends|outlooks?|insights|review|reviews|news)$/i;
const ARTICLE_PREFIX = /^(best|top|how\s+to|why|what\s+is|guide\s+to|the\s+ultimate|the\s+best|the\s+top)\b/i;
function isJunkName(name: string, domain: string): boolean {
  const n = name.trim();
  if (n.length < 2) return true;
  const isMultiWord = /\s/.test(n);
  if (!isMultiWord && n === n.toLowerCase() && n.length > 3) return true;
  if (isMultiWord && n === n.toLowerCase()) return true;
  if (!isMultiWord) {
    if (/^[A-Z]{2,}[a-z]/.test(n)) return true;
    if (n.length > 14) return true;
  }
  if (isMultiWord) {
    const words = n.split(/\s+/);
    if (words.length >= 5) return true;
    if (ARTICLE_SUFFIX.test(n)) return true;
    if (words.length >= 4 && ARTICLE_PREFIX.test(n)) return true;
  }
  if (domain) {
    const d = domain.toLowerCase();
    if ((d.includes('news') || d.includes('blog') || d.includes('report') || d.includes('today')) && !/^[A-Z]/.test(n)) return true;
  }
  return false;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name', 'demo%').order('created_at', { ascending: false }).limit(1).single();
  const WS = ws.data!.id as string;

  // 1. Pull all accounts.
  const accts: Array<{ id: string; name: string; attributes: Record<string, any>; created_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const page = await sb.from('entities').select('id, name, attributes, created_at')
      .eq('workspace_id', WS).eq('kind', 'account').is('archived_at', null)
      .range(from, from + 999);
    const rows = (page.data ?? []) as typeof accts;
    accts.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`total active accounts: ${accts.length}\n`);

  // 2. Name quality.
  let junk = 0;
  for (const a of accts) if (isJunkName(a.name, (a.attributes?.domain as string) ?? '')) junk++;
  console.log(`name quality:`);
  console.log(`  would be hidden as junk: ${junk}  (${((junk / accts.length) * 100).toFixed(0)}%)`);
  console.log(`  display-quality        : ${accts.length - junk}\n`);

  // 3. discovered_via breakdown (attributes-level provenance).
  const via = new Map<string, number>();
  for (const a of accts) via.set((a.attributes?.discovered_via as string) ?? '(none)', (via.get((a.attributes?.discovered_via as string) ?? '(none)') ?? 0) + 1);
  console.log('discovered_via (entity attributes):');
  [...via.entries()].sort((x, y) => y[1] - x[1]).forEach(([k, n]) => console.log(`  ${k.padEnd(16)} ${n}`));

  // 4. Creating source via events.actor_id (action=create_account).
  const ids = accts.map((a) => a.id);
  const actorByEntity = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const evs = await sb.from('events').select('target_id, actor_id')
      .eq('workspace_id', WS).eq('action', 'create_account').in('target_id', chunk);
    for (const e of (evs.data ?? []) as Array<{ target_id: string; actor_id: string }>) {
      if (!actorByEntity.has(e.target_id)) actorByEntity.set(e.target_id, e.actor_id);
    }
  }
  const bySource = new Map<string, number>();
  for (const a of accts) bySource.set(actorByEntity.get(a.id) ?? '(no create event)', (bySource.get(actorByEntity.get(a.id) ?? '(no create event)') ?? 0) + 1);
  console.log('\ncreating source (events.actor_id):');
  [...bySource.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));

  // 5. Name-collision (dedup failure proxy): same lowercased name on >1 row.
  const byLowerName = new Map<string, number>();
  for (const a of accts) byLowerName.set(a.name.trim().toLowerCase(), (byLowerName.get(a.name.trim().toLowerCase()) ?? 0) + 1);
  const dupNames = [...byLowerName.entries()].filter(([, n]) => n > 1).sort((x, y) => y[1] - x[1]);
  const dupRows = dupNames.reduce((s, [, n]) => s + n, 0);
  console.log(`\nname collisions: ${dupNames.length} names appear >1× (${dupRows} rows total)`);
  dupNames.slice(0, 10).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}×  ${k}`));

  // 6. Creation-time clustering (by day).
  const byDay = new Map<string, number>();
  for (const a of accts) byDay.set(a.created_at.slice(0, 10), (byDay.get(a.created_at.slice(0, 10)) ?? 0) + 1);
  console.log('\naccounts created per day (top 10):');
  [...byDay.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).forEach(([d, n]) => console.log(`  ${d}  ${String(n).padStart(5)}  ${'█'.repeat(Math.round(n / 20))}`));

  // 7. Emptiness: accounts with zero facts.
  let withFacts = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const f = await sb.from('facts').select('subject_entity').eq('workspace_id', WS).in('subject_entity', chunk).is('supersedes', null);
    const s = new Set(((f.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity));
    withFacts += s.size;
  }
  console.log(`\nemptiness:`);
  console.log(`  accounts with >=1 fact: ${withFacts}`);
  console.log(`  empty shells (0 facts): ${accts.length - withFacts}  (${(((accts.length - withFacts) / accts.length) * 100).toFixed(0)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
