import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

const GARBAGE = ['settlementradar@agentmail.to', 'ocean-tiger@agentmail.to', 'alan.botts@agentmail.to'];

(async () => {
  // 1. Workspace policy bits the two-tier flow depends on.
  const { data: w } = await db.from('workspaces').select('policy').eq('id', ws).maybeSingle();
  const policy = (w?.policy ?? {}) as any;
  console.log('=== POLICY (flow-critical fields) ===');
  console.log('  scorable_types       :', JSON.stringify(policy.scorable_types ?? '(unset → defaults to [account])'));
  console.log('  enrichment           :', JSON.stringify(policy.enrichment ?? {}, null, 0));
  console.log('  personas.target_roles:', JSON.stringify(policy.personas?.target_roles ?? '(unset)'));
  console.log('  env keys present     :', JSON.stringify(Object.keys(policy.env ?? {})));
  console.log('  HUNTER_API_KEY env   :', process.env.HUNTER_API_KEY ? 'set' : 'MISSING');
  console.log('  EXPLORIUM_API_KEY env:', process.env.EXPLORIUM_API_KEY ? 'set' : 'MISSING');

  // 2. Locate the garbage contacts: by email fact OR by entity name == local-part.
  console.log('\n=== GARBAGE CONTACTS ===');
  for (const email of GARBAGE) {
    const local = email.split('@')[0];
    // entities whose email fact == this address
    const { data: emf } = await db.from('facts')
      .select('subject_entity').eq('workspace_id', ws).eq('predicate', 'email').eq('object_text', email);
    const byEmail = (emf ?? []).map((r: any) => r.subject_entity);
    // entities named exactly like the local-part (the "treated local-part as name" bug)
    const { data: named } = await db.from('entities').select('id, name, attributes').eq('workspace_id', ws).ilike('name', local);
    const ids = new Set<string>([...byEmail, ...((named ?? []).map((e: any) => e.id))]);
    if (!ids.size) { console.log(`  [${email}] NOT FOUND (already gone?)`); continue; }
    for (const id of ids) {
      const { data: ent } = await db.from('entities').select('id, name, attributes').eq('id', id).maybeSingle();
      const { data: facts } = await db.from('facts').select('id, predicate, object_text, object_entity').eq('workspace_id', ws).eq('subject_entity', id);
      // who this contact works_at
      const worksAt = (facts ?? []).find((f: any) => f.predicate === 'works_at');
      console.log(`  [${email}] entity=${id} name="${ent?.name}" is_a=${JSON.stringify((facts??[]).filter((f:any)=>f.predicate==='is_a').map((f:any)=>f.object_text))}`);
      console.log(`     facts(${facts?.length ?? 0}): ${(facts ?? []).map((f: any) => f.predicate).join(', ')}`);
      console.log(`     works_at: ${worksAt?.object_entity ?? '(none)'}`);
      // facts pointing AT this contact (object_entity = id) — e.g. other contacts? channel posts?
      const { data: refs } = await db.from('facts').select('id, predicate, subject_entity').eq('workspace_id', ws).eq('object_entity', id);
      console.log(`     referenced-by facts: ${refs?.length ?? 0}`);
      // channels / posts mentioning this entity
      const { data: chans } = await db.from('channels').select('id').eq('workspace_id', ws).eq('entity_id', id);
      console.log(`     channels with entity_id=this: ${chans?.length ?? 0}`);
    }
  }

  // 3. How many scored contacts exist right now (sanity on whether scoring runs).
  const { data: cscore } = await db.from('facts').select('subject_entity').eq('workspace_id', ws).eq('predicate', 'contact_score').is('supersedes', null);
  console.log(`\n=== CONTACT SCORING ===\n  contacts with a contact_score fact (orig rows): ${cscore?.length ?? 0}`);

  // 4. Pending enrich_contacts requests right now.
  const { data: reqs } = await db.from('facts').select('subject_entity, created_at').eq('workspace_id', ws).eq('predicate', 'contacts_requested').is('supersedes', null);
  const { data: comps } = await db.from('facts').select('subject_entity, created_at').eq('workspace_id', ws).eq('predicate', 'contacts_completed');
  const compMax = new Map<string, string>();
  for (const c of (comps ?? []) as any[]) { const p = compMax.get(c.subject_entity); if (!p || c.created_at > p) compMax.set(c.subject_entity, c.created_at); }
  const reqMax = new Map<string, string>();
  for (const r of (reqs ?? []) as any[]) { const p = reqMax.get(r.subject_entity); if (!p || r.created_at > p) reqMax.set(r.subject_entity, r.created_at); }
  let pending = 0;
  for (const [ent, t] of reqMax) { const d = compMax.get(ent); if (!d || d < t) pending++; }
  console.log(`\n=== ENRICH QUEUE ===\n  distinct accounts with contacts_requested: ${reqMax.size}\n  pending (no completion after request): ${pending}\n  total contacts_completed audit facts: ${comps?.length ?? 0}`);
})();
