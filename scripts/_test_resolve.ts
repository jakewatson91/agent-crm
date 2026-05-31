import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import {
  resolveOrCreateEntity, normalizeEntityName, trigramSim, looksLikeEntityName,
} from '@agent-crm/tools';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  cond ? pass++ : fail++;
}

async function main() {
  // ---- pure functions ----
  console.log('pure functions:');
  check('normalize strips legal suffix', normalizeEntityName('Stripe Inc.') === normalizeEntityName('Stripe'), `${normalizeEntityName('Stripe Inc.')} == ${normalizeEntityName('Stripe')}`);
  check('normalize handles punctuation', normalizeEntityName('Stripe, Inc.') === 'stripe');
  check('looksLike rejects too-short', looksLikeEntityName('a') === false);
  check('looksLike rejects long sentence', looksLikeEntityName('we will be onboarding many new enterprise clients this quarter soon') === false);
  check('looksLike accepts a real name', looksLikeEntityName('Bank of America') === true);
  check('trigram identical = 1', trigramSim('stripe', 'stripe') === 1);
  check('trigram different = low', trigramSim('stripe', 'notion') < 0.3);

  // ---- live resolution ----
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'resolver-test' };
  console.log('\nlive resolution (workspace af602fa1):');

  // pre-clean any entities left by a prior run so this test is repeatable
  const fakeName = 'Zzztest Resolver Co';
  const fakeDomain = 'zzztest-resolver-example.test';
  const junkName = 'we are actively onboarding new clients';
  for (const nm of [fakeName, junkName]) {
    const ents = (await sb.from('entities').select('id').eq('workspace_id', ws).eq('name', nm)).data ?? [];
    for (const e of ents as Array<{ id: string }>) {
      await sb.from('facts').delete().eq('subject_entity', e.id);
      await sb.from('entities').delete().eq('id', e.id);
    }
  }

  // 1. existing entity resolves, no creation
  const notion = await resolveOrCreateEntity(sb, actor, { name: 'Notion', object_type: 'account', subject_entity: '00000000-0000-0000-0000-000000000000' });
  check('"Notion" resolves to existing (no create)', notion.entity_id !== null && !notion.created, `${notion.reason} conf=${notion.confidence}`);

  // 2. junk does not become an entity
  const junk = await resolveOrCreateEntity(sb, actor, { name: junkName, object_type: 'account', subject_entity: '00000000-0000-0000-0000-000000000000' });
  check('junk phrase is not created', junk.entity_id === null && !junk.created, junk.reason);

  // 3. self-reference excluded: resolving an entity's own name with itself as subject must not return itself
  const someEnt = (await sb.from('entities').select('id, name').eq('workspace_id', ws).limit(1)).data?.[0] as { id: string; name: string };
  const self = await resolveOrCreateEntity(sb, actor, { name: someEnt.name, object_type: 'account', subject_entity: someEnt.id });
  check('self-reference not returned', self.entity_id !== someEnt.id, `name="${someEnt.name}" -> ${self.reason}`);

  // 4. grounded new org -> creates a candidate; second call is idempotent. Then clean up.
  const c1 = await resolveOrCreateEntity(sb, actor, { name: fakeName, object_type: 'account', domain: fakeDomain, subject_entity: '00000000-0000-0000-0000-000000000000' });
  check('grounded new org is created', c1.created && c1.entity_id !== null, c1.reason);
  const c2 = await resolveOrCreateEntity(sb, actor, { name: fakeName, object_type: 'account', domain: fakeDomain, subject_entity: '00000000-0000-0000-0000-000000000000' });
  check('second call is idempotent (resolves, no new node)', !c2.created && c2.entity_id === c1.entity_id, `${c2.reason}`);
  // candidate is marked
  if (c1.entity_id) {
    const ent = (await sb.from('entities').select('attributes').eq('id', c1.entity_id).maybeSingle()).data as any;
    check('candidate flagged in attributes', ent?.attributes?.candidate === true);
    // cleanup: delete facts then entity (the create event stays; append-only)
    await sb.from('facts').delete().eq('subject_entity', c1.entity_id);
    await sb.from('entities').delete().eq('id', c1.entity_id);
    console.log(`  cleaned up test entity ${c1.entity_id.slice(0, 8)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
