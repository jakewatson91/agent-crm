/**
 * Research-quality investigation, step 0: what workspaces exist, how much
 * research has run recently, and what the last 7 days of research actually
 * fetched (url, angle, hook class, dates).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const ws = await sb.from('workspaces').select('id, name, about, created_at').order('created_at');
  console.log('=== WORKSPACES ===');
  for (const w of ws.data ?? []) {
    const sig = await sb.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id);
    const fct = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id);
    const ent = await sb.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id);
    console.log(`${w.id}  ${w.name}  entities=${ent.count} signals=${sig.count} facts=${fct.count}`);
    console.log(`    about: ${(w.about ?? '').slice(0, 200).replace(/\n/g, ' ')}`);
  }

  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  console.log('\n=== research_result signals, last 7d, by workspace ===');
  for (const w of ws.data ?? []) {
    const r = await sb.from('signals').select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id).eq('type', 'research_result').gte('observed_at', since);
    const f = await sb.from('facts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id).gte('created_at', since);
    if ((r.count ?? 0) > 0 || (f.count ?? 0) > 0) console.log(`  ${w.name}: research_signals_7d=${r.count} facts_7d=${f.count}`);
  }
})();
