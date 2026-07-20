import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const THRESH = { icp: 0.65, signal: 0.70, evidence: 0.50, contact: 0.50, suppression_days: 14 };

async function fetchAllFacts(preds: string[]) {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('facts')
      .select('subject_entity, predicate, object_text, observed_at, created_at, supersedes')
      .eq('workspace_id', ws)
      .in('predicate', preds)
      .is('supersedes', null)
      .range(from, from + 999)
      .order('observed_at', { ascending: false });
    if (error) { console.error(error); break; }
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  // 1. Score facts
  const scoreFacts = await fetchAllFacts(['score_total', 'score_signal_strength', 'score_evidence_depth']);

  // Latest per (entity, predicate)
  const seen = new Map<string, any>();
  for (const f of scoreFacts) {
    const key = `${f.subject_entity}::${f.predicate}`;
    if (!seen.has(key)) seen.set(key, f);
  }

  const scores = new Map<string, { icp_total?: number; signal_strength?: number; evidence_depth?: number }>();
  for (const [key, f] of seen) {
    const [eid, pred] = key.split('::');
    if (!scores.has(eid)) scores.set(eid, {});
    const row = scores.get(eid)!;
    const val = parseFloat(f.object_text);
    if (pred === 'score_total') row.icp_total = val;
    else if (pred === 'score_signal_strength') row.signal_strength = val;
    else if (pred === 'score_evidence_depth') row.evidence_depth = val;
  }

  // Accounts clearing all three score gates
  const qualifying = [...scores.entries()].filter(([, r]) =>
    (r.icp_total ?? 0) >= THRESH.icp &&
    (r.signal_strength ?? 0) >= THRESH.signal &&
    (r.evidence_depth ?? 0) >= THRESH.evidence
  );
  const qualIds = qualifying.map(([id]) => id);
  console.log(`Accounts clearing 3 score gates: ${qualIds.length}`);

  // 2. Contact scores — find accounts linked to contacts with contact_score
  // contacts link to accounts via works_at facts
  const worksAtFacts = await fetchAllFacts(['works_at']);
  // { contact_entity -> account_entity }
  const contactToAccount = new Map<string, string>();
  for (const f of worksAtFacts) {
    contactToAccount.set(f.subject_entity, f.object_text); // object_text = account id
  }

  // contact_score facts
  const contactScoreFacts = await fetchAllFacts(['contact_score']);
  const latestContactScore = new Map<string, number>();
  const contactScoreSeen = new Map<string, boolean>();
  for (const f of contactScoreFacts) {
    if (!contactScoreSeen.has(f.subject_entity)) {
      contactScoreSeen.set(f.subject_entity, true);
      latestContactScore.set(f.subject_entity, parseFloat(f.object_text));
    }
  }

  // Best contact score per account
  const bestContactScore = new Map<string, number>();
  for (const [contactId, score] of latestContactScore) {
    const accountId = contactToAccount.get(contactId);
    if (!accountId) continue;
    const current = bestContactScore.get(accountId) ?? 0;
    if (score > current) bestContactScore.set(accountId, score);
  }

  // 3. Recent touch_draft facts (suppression)
  const touchDraftFacts = await fetchAllFacts(['touch_draft']);
  // Actually touch_draft is a timeline event, not a fact. Check via different predicate.
  // Let's check outreach_cooldown_until
  const cooldownFacts = await fetchAllFacts(['outreach_cooldown_until']);
  const onCooldown = new Set<string>();
  const now = Date.now();
  for (const f of cooldownFacts) {
    const until = Date.parse(f.object_text);
    if (until > now) onCooldown.set(f.subject_entity);
  }

  // 4. Pivot results for qualifying accounts
  let noContact = 0, weakContact = 0, suppressed = 0, readyToDraft = 0;
  const readyList: any[] = [];

  for (const [id, r] of qualifying) {
    const best = bestContactScore.get(id);
    const cooled = onCooldown.has(id);

    if (best === undefined) { noContact++; continue; }
    if (best < THRESH.contact) { weakContact++; continue; }
    if (cooled) { suppressed++; continue; }
    readyToDraft++;
    readyList.push({ id, ...r, best_contact: best });
  }

  console.log(`\nOf those 41 — why no draft:`);
  console.log(`  No linked scored contact:  ${noContact}`);
  console.log(`  Contact score < 0.50:      ${weakContact}`);
  console.log(`  On outreach cooldown:      ${suppressed}`);
  console.log(`  Actually ready to draft:   ${readyToDraft}`);

  if (readyList.length) {
    const ids = readyList.map(r => r.id);
    const { data: ents } = await sb.from('entities').select('id, name').in('id', ids);
    const nameMap = new Map((ents ?? []).map((e: any) => [e.id, e.name]));
    console.log('\nReady accounts:');
    for (const r of readyList) {
      console.log(`  ${nameMap.get(r.id) ?? r.id.slice(0,8)}  icp=${r.icp_total?.toFixed(2)} sig=${r.signal_strength?.toFixed(2)} dep=${r.evidence_depth?.toFixed(2)} contact=${r.best_contact?.toFixed(2)}`);
    }
  }

  // Also check what the actual pending approvals look like
  const { data: gates } = await sb.from('gates')
    .select('id, entity_id, kind, status, created_at')
    .eq('workspace_id', ws)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`\nPending gates in DB: ${gates?.length ?? 0}`);
  if (gates?.length) {
    const gateEntityIds = gates.map((g: any) => g.entity_id).filter(Boolean);
    const { data: gateEnts } = await sb.from('entities').select('id, name').in('id', gateEntityIds);
    const gMap = new Map((gateEnts ?? []).map((e: any) => [e.id, e.name]));
    for (const g of gates) {
      console.log(`  ${g.kind}  ${gMap.get(g.entity_id) ?? g.entity_id?.slice(0,8)}  ${g.created_at?.slice(0,10)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
