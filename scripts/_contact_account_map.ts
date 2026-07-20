import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function fetchAllFacts(preds: string[], cols = 'subject_entity, predicate, object_text, object_entity, observed_at, supersedes') {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('facts')
      .select(cols)
      .eq('workspace_id', ws).in('predicate', preds).is('supersedes', null)
      .range(from, from + 999).order('observed_at', { ascending: false });
    if (error) { console.error('fetch error:', error.message); break; }
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  // Score gates: recompute qualifying account IDs
  const scoreFacts = await fetchAllFacts(['score_total', 'score_signal_strength', 'score_evidence_depth']);
  const seen = new Map<string, any>();
  for (const f of scoreFacts) {
    const key = `${f.subject_entity}::${f.predicate}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  const scores = new Map<string, any>();
  for (const [key, f] of seen) {
    const [eid, pred] = key.split('::');
    if (!scores.has(eid)) scores.set(eid, {});
    const val = parseFloat(f.object_text);
    if (pred === 'score_total') scores.get(eid).icp_total = val;
    else if (pred === 'score_signal_strength') scores.get(eid).signal_strength = val;
    else if (pred === 'score_evidence_depth') scores.get(eid).evidence_depth = val;
  }
  const qualIds = new Set([...scores.entries()]
    .filter(([, r]) => (r.icp_total??0) >= 0.65 && (r.signal_strength??0) >= 0.70 && (r.evidence_depth??0) >= 0.50)
    .map(([id]) => id));
  console.log(`Qualifying accounts (all 3 gates): ${qualIds.size}`);

  // works_at: contact -> account via object_entity (NOT object_text)
  const worksAtFacts = await fetchAllFacts(['works_at']);
  console.log(`\nTotal works_at facts: ${worksAtFacts.length}`);

  // What's actually in object_entity vs object_text for works_at?
  const hasObjEntity = worksAtFacts.filter(f => f.object_entity != null);
  const hasObjText   = worksAtFacts.filter(f => f.object_text != null);
  console.log(`  object_entity populated: ${hasObjEntity.length}`);
  console.log(`  object_text populated:   ${hasObjText.length}`);

  // Sample
  console.log('\nSample works_at facts:');
  for (const f of worksAtFacts.slice(0, 5)) {
    console.log(`  contact=${f.subject_entity.slice(0,8)}  obj_entity=${f.object_entity?.slice(0,8) ?? 'NULL'}  obj_text=${f.object_text ?? 'NULL'}`);
  }

  // Build contact -> account map using object_entity
  const contactToAccount = new Map<string, string>();
  for (const f of worksAtFacts) {
    if (f.object_entity) contactToAccount.set(f.subject_entity, f.object_entity);
  }

  // contact_score facts
  const contactScoreFacts = await fetchAllFacts(['contact_score']);
  const latestContactScore = new Map<string, number>();
  const seenContact = new Set<string>();
  for (const f of contactScoreFacts) {
    if (!seenContact.has(f.subject_entity)) {
      seenContact.add(f.subject_entity);
      latestContactScore.set(f.subject_entity, parseFloat(f.object_text));
    }
  }
  console.log(`\nScored contacts: ${latestContactScore.size}`);

  // Best contact score per account
  const bestContactScore = new Map<string, number>();
  for (const [contactId, score] of latestContactScore) {
    const accountId = contactToAccount.get(contactId);
    if (!accountId) continue;
    const current = bestContactScore.get(accountId) ?? 0;
    if (score > current) bestContactScore.set(accountId, score);
  }
  console.log(`Accounts with at least one scored contact: ${bestContactScore.size}`);
  const overlap = [...bestContactScore.keys()].filter(id => qualIds.has(id));
  console.log(`Of the 41 qualifying: ${overlap.length} have a scored contact`);

  // For the 41 qualifying — detailed breakdown
  let noLink = 0, noScore = 0, weakScore = 0, ready = 0;
  const readyList: any[] = [];
  for (const id of qualIds) {
    const linked = contactToAccount.size > 0 && [...contactToAccount.values()].includes(id);
    const best = bestContactScore.get(id);
    if (best === undefined && !linked) { noLink++; continue; }
    if (best === undefined) { noScore++; continue; }
    if (best < 0.5) { weakScore++; continue; }
    ready++;
    readyList.push({ id, best, ...scores.get(id) });
  }
  console.log(`\nOf the 41:`);
  console.log(`  No linked contact at all:       ${noLink}`);
  console.log(`  Linked but no score yet:        ${noScore}`);
  console.log(`  Linked + scored but < 0.50:     ${weakScore}`);
  console.log(`  Ready to draft (contact ≥ 0.50): ${ready}`);

  // Show where the 197 scored contacts ARE linked
  const accountsWithScoredContacts = new Map<string, { count: number; bestScore: number; name?: string }>();
  for (const [contactId, score] of latestContactScore) {
    const accountId = contactToAccount.get(contactId);
    if (!accountId) continue;
    const entry = accountsWithScoredContacts.get(accountId) ?? { count: 0, bestScore: 0 };
    entry.count++;
    if (score > entry.bestScore) entry.bestScore = score;
    accountsWithScoredContacts.set(accountId, entry);
  }

  const noContactAccountIds = [...latestContactScore.keys()].filter(id => !contactToAccount.has(id));
  console.log(`\nScored contacts with NO works_at link: ${noContactAccountIds.length}`);

  // Enrich account names
  const linkedAccountIds = [...accountsWithScoredContacts.keys()];
  if (linkedAccountIds.length) {
    const { data: ents } = await sb.from('entities').select('id, name').in('id', linkedAccountIds.slice(0, 100));
    for (const e of ents ?? []) {
      const entry = accountsWithScoredContacts.get(e.id)!;
      entry.name = e.name;
    }
    const sorted = [...accountsWithScoredContacts.entries()]
      .sort(([, a], [, b]) => b.bestScore - a.bestScore)
      .slice(0, 20);
    console.log(`\nAccounts that DO have scored contacts (top 20 by contact score):`);
    for (const [id, entry] of sorted) {
      const inQual = qualIds.has(id) ? ' ← QUALIFIES' : '';
      const accScore = scores.get(id);
      const scoreStr = accScore ? ` [icp=${accScore.icp_total?.toFixed(2)} sig=${accScore.signal_strength?.toFixed(2)} dep=${accScore.evidence_depth?.toFixed(2)}]` : ' [no acct score]';
      console.log(`  ${entry.name ?? id.slice(0,8)}  contacts=${entry.count}  best_contact=${entry.bestScore.toFixed(2)}${scoreStr}${inQual}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
