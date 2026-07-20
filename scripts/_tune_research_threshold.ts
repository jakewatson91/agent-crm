import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { embed } from '@agent-crm/primitives';

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name, about, icp')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no workspace');
  const about = (ws.data.about as string) ?? '';
  const icp = (ws.data.icp as Record<string, unknown>) ?? {};
  const pain = Array.isArray((icp as any).pain) ? (icp as any).pain.join('; ') : '';

  const semanticQuery = [
    'Research findings worth recording as facts about a prospective account.',
    about ? `This business: ${about}` : '',
    pain ? `Watch especially for signals matching these pain points: ${pain}.` : '',
    'Look for funding events, leadership or hiring changes, product launches, pricing or tooling changes, customer wins or losses, and any stated operational pain.',
  ].filter(Boolean).join(' ').slice(0, 1800);

  console.log('semantic_query length:', semanticQuery.length);
  const qVec = await embed(semanticQuery);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sigs = await sb.from('signals')
    .select('id, entity_id, embedding, structured_tags, body_for_embedding')
    .eq('workspace_id', ws.data.id)
    .eq('type', 'research_result')
    .gte('observed_at', since)
    .limit(200);
  if (sigs.error) throw sigs.error;

  const sims: number[] = [];
  for (const s of sigs.data ?? []) {
    const vec = JSON.parse(s.embedding as unknown as string) as number[];
    sims.push(cosine(qVec, vec));
  }
  sims.sort((a, b) => b - a);
  console.log(`n=${sims.length}`);
  console.log('max:', sims[0]?.toFixed(3));
  console.log('p25 (top quartile cutoff):', sims[Math.floor(sims.length * 0.25)]?.toFixed(3));
  console.log('median:', sims[Math.floor(sims.length * 0.5)]?.toFixed(3));
  console.log('p75:', sims[Math.floor(sims.length * 0.75)]?.toFixed(3));
  console.log('min:', sims[sims.length - 1]?.toFixed(3));
  for (const t of [0.2, 0.25, 0.3, 0.35, 0.4]) {
    const pass = sims.filter((x) => x >= t).length;
    console.log(`threshold ${t}: ${pass}/${sims.length} pass (${(100 * pass / sims.length).toFixed(0)}%)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
