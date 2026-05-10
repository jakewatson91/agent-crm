import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
  const WS = ws.data!.id;

  // Latest 3 claim posts from audit_yc_scorer
  const claims = await sb.from('channel_posts').select('id, body, cites, channels!inner(account_entity_id, title)').eq('author_id', 'claims_audit_yc_scorer').eq('kind', 'claim').order('created_at', { ascending: false }).limit(3);
  console.log('=== 3 SAMPLE CLAIM_POSTER OUTPUTS ===\n');
  for (const c of claims.data ?? []) {
    const channel = (c.channels as any) ?? {};
    console.log(`[${channel.title}]`);
    console.log(c.body);
    console.log(`cites: ${(c.cites as string[]).length}`);
    console.log('');
  }

  // Latest 3 drafts from audit_yc_drafter (post_touch_draft kind)
  const drafts = await sb.from('channel_posts').select('id, body, cites, channels!inner(title)').eq('author_id', 'claims_audit_yc_drafter').eq('kind', 'touch_draft').order('created_at', { ascending: false }).limit(3);
  console.log('\n=== SAMPLE DRAFTS (would i send these?) ===\n');
  for (const d of drafts.data ?? []) {
    const channel = (d.channels as any) ?? {};
    console.log(`[${channel.title}]`);
    console.log(d.body);
    console.log(`cites: ${(d.cites as string[]).length}`);
    console.log('---');
  }

  // 5 sample facts from audit_yc_enricher
  const events = await sb.from('events').select('id, payload, target_id, parent_event_id').eq('actor_id', 'claims_audit_yc_enricher').eq('action', 'assert_fact').order('id', { ascending: false }).limit(8);
  console.log('\n=== 8 SAMPLE ENRICHER FACTS ===\n');
  for (const e of events.data ?? []) {
    const p = e.payload as any;
    // Get the entity name + the parent signal that triggered
    const factRow = await sb.from('facts').select('id, subject_entity').eq('id', e.target_id).maybeSingle();
    const entRow = factRow.data ? await sb.from('entities').select('name').eq('id', factRow.data.subject_entity).maybeSingle() : null;
    const sig = e.parent_event_id ? await sb.from('events').select('payload').eq('id', e.parent_event_id).maybeSingle() : null;
    const sigBody = (sig?.data?.payload as any)?.body_for_embedding ?? '';
    console.log(`${entRow?.data?.name ?? '?'} | ${p.predicate} = "${p.object_text}"  (conf=${p.confidence})`);
    console.log(`  signal: "${(sigBody as string).slice(0, 140)}"`);
    console.log('');
  }

  // Provenance walk: pick the latest fact and walk all the way back
  console.log('\n=== PROVENANCE WALK on most recent enricher fact ===\n');
  const lastFactEvent = events.data?.[0];
  if (lastFactEvent) {
    let cursor = lastFactEvent;
    let hop = 0;
    while (cursor && hop < 6) {
      console.log(`hop ${hop}: event ${cursor.id}`);
      const ev = await sb.from('events').select('id, action, actor_id, actor_kind, payload, parent_event_id, prompt_hash, created_at').eq('id', cursor.id).single();
      console.log(`  action:    ${ev.data!.action}`);
      console.log(`  actor:     ${ev.data!.actor_kind}/${ev.data!.actor_id}`);
      console.log(`  prompt_hash: ${(ev.data!.prompt_hash as string)?.slice(0, 16) ?? '(none)'}…`);
      console.log(`  payload:   ${JSON.stringify(ev.data!.payload).slice(0, 200)}`);
      if (!ev.data!.parent_event_id) break;
      const next = await sb.from('events').select('id, action, actor_id, actor_kind, payload, parent_event_id, prompt_hash, created_at').eq('id', ev.data!.parent_event_id).single();
      cursor = next.data as any;
      hop++;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
