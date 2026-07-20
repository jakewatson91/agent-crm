import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

// The 41 qualifying account IDs — recompute from score facts
async function fetchAllFacts(preds: string[]) {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('facts')
      .select('subject_entity, predicate, object_text, observed_at, supersedes')
      .eq('workspace_id', ws).in('predicate', preds).is('supersedes', null)
      .range(from, from + 999).order('observed_at', { ascending: false });
    if (error || !data?.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
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
  const qualIds = [...scores.entries()]
    .filter(([, r]) => (r.icp_total??0) >= 0.65 && (r.signal_strength??0) >= 0.70 && (r.evidence_depth??0) >= 0.50)
    .map(([id]) => id);

  // works_at: contact -> account
  const worksAtFacts = await fetchAllFacts(['works_at']);
  const contactToAccount = new Map<string, string>();
  for (const f of worksAtFacts) contactToAccount.set(f.subject_entity, f.object_text);

  // All contacts linked to qualifying accounts
  const linkedContacts = [...contactToAccount.entries()]
    .filter(([, accId]) => qualIds.includes(accId))
    .map(([contactId]) => contactId);

  // Which contacts have contact_score facts?
  const contactScoreFacts = await fetchAllFacts(['contact_score']);
  const scoredContacts = new Set(contactScoreFacts.map(f => f.subject_entity));

  const linkedScored = linkedContacts.filter(id => scoredContacts.has(id));

  console.log(`Qualifying accounts (3 gates): ${qualIds.length}`);
  console.log(`Contacts linked to those accounts: ${linkedContacts.length}`);
  console.log(`Of those, contacts with a score: ${linkedScored.length}`);
  console.log(`Contacts with scores but wrong account link (not in qualifying): ${scoredContacts.size - linkedScored.length}`);

  // Check a sample of unscored contacts
  const unscoredLinked = linkedContacts.filter(id => !scoredContacts.has(id)).slice(0, 10);
  if (unscoredLinked.length) {
    const { data: contactEnts } = await sb.from('entities').select('id, name').in('id', unscoredLinked);
    console.log('\nSample unscored contacts linked to qualifying accounts:');
    for (const e of contactEnts ?? []) console.log(`  ${e.name}`);
  }

  // Total contact_score facts in workspace
  console.log(`\nTotal contact_score facts in workspace: ${contactScoreFacts.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
