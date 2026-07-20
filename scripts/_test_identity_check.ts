import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { cosine } from '@agent-crm/tools';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const entityId = '756aa76d-a8f2-481d-8f1b-2e13a4fd800d'; // Approxima (YC W26, approxima.ai)

  const ident = await sb.from('entity_embeddings')
    .select('embedding, perspective')
    .eq('entity_id', entityId)
    .eq('perspective', 'default')
    .maybeSingle();
  if (ident.error || !ident.data) { console.log('no default identity embedding:', ident.error?.message); return; }
  const identVec = JSON.parse(ident.data.embedding as unknown as string) as number[];

  const sigs = await sb.from('signals')
    .select('id, structured_tags, embedding, body_for_embedding')
    .eq('entity_id', entityId)
    .eq('type', 'research_result')
    .order('observed_at', { ascending: false })
    .limit(10);
  if (sigs.error) throw sigs.error;

  for (const s of sigs.data ?? []) {
    const vec = JSON.parse(s.embedding as unknown as string) as number[];
    const sim = cosine(identVec, vec);
    const url = (s.structured_tags as any)?.url ?? '(no url)';
    console.log(`${sim.toFixed(3)}  ${url}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
