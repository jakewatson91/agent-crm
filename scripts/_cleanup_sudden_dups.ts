/**
 * One-time cleanup of the duplicate enrichment posts + synonym facts that the
 * pre-fix concurrency race left on the Sudden workspace (see the going-forward
 * fix in agent_run.ts / research.ts). Dry-run by default; pass --execute to apply.
 *
 *  POSTS: within a channel, claim/decision posts that are near-identical
 *  (same kind, within 30 min, body token-overlap >= 0.5) are one burst's
 *  duplicates. Keep the richest (most cites, tie newest); delete the rest.
 *  A deleted claim's child decision posts are removed with it (FK-safe order).
 *
 *  FACTS: same entity + same DISTINCTIVE value (has a space AND >= 8 chars, so
 *  boolean/single-word values like "Yes" or "Bitmovin" are never collapsed)
 *  appearing under 2+ rows is a synonym-predicate duplicate. Keep the earliest;
 *  delete the rest. Facts cited by any pending draft are never touched.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const EXECUTE = process.argv.includes('--execute');

async function pageAll<T>(b: (f: number, t: number) => any): Promise<T[]> {
  const o: T[] = []; let f = 0;
  for (;;) { const { data, error } = await b(f, f + 999); if (error) throw error; o.push(...(data as T[])); if (!data || data.length < 1000) break; f += 1000; }
  return o;
}
const toks = (s: string) => new Set(String(s).toLowerCase().split(/\W+/).filter((t) => t.length > 4));
const jaccard = (a: Set<string>, b: Set<string>) => { const inter = [...a].filter((t) => b.has(t)).length; const uni = new Set([...a, ...b]).size; return uni ? inter / uni : 0; };
const WINDOW = 30 * 60_000, SIM = 0.5;

async function main() {
  const chans = await pageAll<any>((f, t) => sb.from('channels').select('id, account_entity_id').eq('workspace_id', WS).range(f, t));
  const chanIds = chans.map((c) => c.id);
  const entByChan = new Map(chans.map((c) => [c.id, c.account_entity_id]));
  const entIds = [...new Set(chans.map((c) => c.account_entity_id).filter(Boolean))];
  const nameById = new Map<string, string>();
  for (let i = 0; i < entIds.length; i += 300) { const { data } = await sb.from('entities').select('id, name').in('id', entIds.slice(i, i + 300)); for (const e of (data ?? []) as any[]) nameById.set(e.id, e.name); }

  // ---- POSTS ----
  let posts: any[] = [];
  for (let i = 0; i < chanIds.length; i += 150) { const b = chanIds.slice(i, i + 150); posts.push(...await pageAll<any>((f, t) => sb.from('channel_posts').select('id, channel_id, kind, body, cites, parent_post_id, created_at').in('channel_id', b).in('kind', ['claim', 'decision']).range(f, t))); }
  const childrenOf = new Map<string, string[]>(); // claimId -> [decision child ids]
  for (const p of posts) if (p.parent_post_id) (childrenOf.get(p.parent_post_id) ?? childrenOf.set(p.parent_post_id, []).get(p.parent_post_id))!.push(p.id);

  const byChanKind = new Map<string, any[]>();
  for (const p of posts) { const k = `${p.channel_id}::${p.kind}`; (byChanKind.get(k) ?? byChanKind.set(k, []).get(k))!.push(p); }

  const delClaims = new Set<string>(), delDecisions = new Set<string>();
  const postSamples: string[] = [];
  for (const [key, arr] of byChanKind) {
    const kind = key.split('::')[1];
    const list = arr.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const used = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const cluster = [i]; const ti = toks(list[i].body);
      for (let j = i + 1; j < list.length; j++) { if (used.has(j)) continue; if (Date.parse(list[j].created_at) - Date.parse(list[i].created_at) > WINDOW) break; if (jaccard(ti, toks(list[j].body)) >= SIM) { cluster.push(j); used.add(j); } }
      if (cluster.length < 2) continue;
      used.add(i);
      // keep the richest (most cites), tie-break newest
      const keepIdx = cluster.slice().sort((a, b) => (list[b].cites?.length ?? 0) - (list[a].cites?.length ?? 0) || Date.parse(list[b].created_at) - Date.parse(list[a].created_at))[0];
      for (const idx of cluster) {
        if (idx === keepIdx) continue;
        const p = list[idx];
        if (kind === 'claim') { delClaims.add(p.id); for (const c of childrenOf.get(p.id) ?? []) delDecisions.add(c); }
        else delDecisions.add(p.id);
      }
      if (postSamples.length < 12) { const nm = nameById.get(entByChan.get(list[i].channel_id)) ?? '?'; postSamples.push(`${nm} [${kind}] keep 1 of ${cluster.length}: "${String(list[keepIdx].body).replace(/\n/g, ' ').slice(0, 62)}"`); }
    }
  }
  // Don't double-count a decision already scheduled as a claim's child.
  for (const id of delDecisions) delClaims.delete(id);
  console.log(`POSTS: delete ${delClaims.size} claims + ${delDecisions.size} decisions = ${delClaims.size + delDecisions.size} total`);
  postSamples.forEach((s) => console.log('  ' + s));

  // ---- FACTS ----
  // protected: cited by any pending draft
  let drafts: any[] = [];
  for (let i = 0; i < chanIds.length; i += 150) { const b = chanIds.slice(i, i + 150); drafts.push(...await pageAll<any>((f, t) => sb.from('channel_posts').select('cites').in('channel_id', b).eq('kind', 'touch_draft').range(f, t))); }
  const protectedFacts = new Set<string>(); for (const d of drafts) for (const c of (d.cites ?? [])) protectedFacts.add(c);

  const facts = await pageAll<any>((f, t) => sb.from('facts').select('id, subject_entity, predicate, object_text, supersedes, created_at').eq('workspace_id', WS).range(f, t));
  const pointed = new Set(facts.map((f) => f.supersedes).filter(Boolean));
  const active = facts.filter((f) => !pointed.has(f.id) && !f.predicate.startsWith('score_') && !f.predicate.endsWith('_breakdown') && !['icp_fit', 'contact_score', 'outreach_stage', 'dropped_until', 'outreach_cooldown_until', 'contact_lookup_attempted', 'is_a'].includes(f.predicate));
  const distinctive = (v: string) => { const t = v.trim(); return t.length >= 8 && /\s/.test(t) && !/^(true|false|yes|no|n\/a|none)$/i.test(t); };
  const grp = new Map<string, any[]>();
  for (const f of active) { const v = (f.object_text ?? '').trim(); if (!distinctive(v)) continue; const k = `${f.subject_entity}::${v.toLowerCase()}`; (grp.get(k) ?? grp.set(k, []).get(k))!.push(f); }
  const delFacts: string[] = []; const factSamples: string[] = [];
  for (const [, rows] of grp) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)); // earliest first = keeper
    const losers = rows.slice(1).filter((r) => !protectedFacts.has(r.id));
    for (const l of losers) delFacts.push(l.id);
    if (losers.length && factSamples.length < 14) { const nm = nameById.get(rows[0].subject_entity) ?? '?'; factSamples.push(`${nm}: keep [${rows[0].predicate}], drop [${losers.map((l) => l.predicate).join(', ')}] = "${String(rows[0].object_text).slice(0, 44)}"`); }
  }
  console.log(`\nFACTS: delete ${delFacts.length} synonym-duplicate facts (protected by drafts, skipped: ${[...protectedFacts].length ? protectedFacts.size : 0})`);
  factSamples.forEach((s) => console.log('  ' + s));

  if (!EXECUTE) { console.log('\n[dry-run] pass --execute to apply'); return; }

  // delete decisions (leaves) first, then claims, then facts
  const delInBatches = async (table: string, ids: string[]) => { let n = 0; for (let i = 0; i < ids.length; i += 100) { const b = ids.slice(i, i + 100); const { error } = await sb.from(table).delete().in('id', b); if (error) throw error; n += b.length; } return n; };
  const d1 = await delInBatches('channel_posts', [...delDecisions]);
  const d2 = await delInBatches('channel_posts', [...delClaims]);
  const d3 = await delInBatches('facts', delFacts);
  console.log(`\nDONE. deleted ${d1} decision posts, ${d2} claim posts, ${d3} facts.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
