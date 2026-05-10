/**
 * Drill into specific channels: full post bodies, signal bodies, fact lists.
 * Targets: highest-activity, suspicious-name (manishbhusal), and high-value real
 * companies (Stripe, Ramp, Kalshi).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const TARGETS = ['manishbhusal', 'Ramp', 'Stripe', 'Kalshi', 'The Token Company', 'Ventura', 'Hatch', 'Kodiak AI', 'Scheduling Wizard'];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
  const WS = ws.data!.id;

  for (const name of TARGETS) {
    const ent = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).eq('name', name).maybeSingle();
    if (!ent.data) { console.log(`\n=== ${name}: NOT FOUND ===`); continue; }

    const ch = await sb.from('channels').select('id').eq('account_entity_id', ent.data.id).maybeSingle();
    const sigs = await sb.from('signals').select('type, body_for_embedding, structured_tags, observed_at').eq('entity_id', ent.data.id).order('observed_at', { ascending: false }).limit(5);
    const facts = await sb.from('facts').select('id, predicate, object_text, confidence, supersedes').eq('subject_entity', ent.data.id);
    const posts = await sb.from('channel_posts').select('kind, body, cites, author_id, created_at').eq('channel_id', ch.data!.id).order('created_at', { ascending: false }).limit(10);

    console.log(`\n========= ${name} =========`);
    console.log(`attrs: ${JSON.stringify(ent.data.attributes ?? {}).slice(0, 200)}`);
    console.log(`\n[SIGNALS] ${sigs.data?.length ?? 0}:`);
    for (const s of sigs.data ?? []) {
      const src = ((s.structured_tags as Record<string, unknown> | null)?.signal_source as string) ?? '?';
      console.log(`  · [${s.type}/${src}] ${(s.body_for_embedding as string ?? '').slice(0, 200)}`);
    }
    const supersededIds = new Set((facts.data ?? []).map((f) => f.supersedes).filter((x): x is string => !!x));
    const activeFacts = (facts.data ?? []).filter((f) => !supersededIds.has(f.id as string));
    console.log(`\n[ACTIVE FACTS] ${activeFacts.length}:`);
    for (const f of activeFacts) console.log(`  ${f.predicate} = ${f.object_text}  (conf=${f.confidence})`);

    console.log(`\n[POSTS] ${posts.data?.length ?? 0}:`);
    for (const p of posts.data ?? []) {
      console.log(`  --- [${p.kind}] by ${p.author_id} cites=${((p.cites as string[]) ?? []).length} ---`);
      console.log(`  ${(p.body as string).slice(0, 350)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
