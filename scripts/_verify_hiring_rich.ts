import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

(async () => {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const TEN_MIN_AGO = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // 1. Count fresh hiring signals
  const freshCount = await sb
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS)
    .eq('type', 'hiring_post')
    .gte('created_at', TEN_MIN_AGO);
  console.log('Fresh hiring_post signals (last 30 min):', freshCount.count);

  // 2. Show top 3 with rich tags
  const sample = await sb
    .from('signals')
    .select('id, body_for_embedding, structured_tags, created_at')
    .eq('workspace_id', WS)
    .eq('type', 'hiring_post')
    .gte('created_at', TEN_MIN_AGO)
    .order('created_at', { ascending: false })
    .limit(3);

  for (const s of sample.data ?? []) {
    const t = (s.structured_tags ?? {}) as Record<string, any>;
    console.log('\n---');
    console.log('signal_id:', s.id);
    console.log('role_family:', t.role_family, '| seniority:', t.role_seniority, '| is_exec:', t.role_is_exec);
    console.log('job_title:', t.job_title);
    console.log('salary:', t.job_salary_min, '-', t.job_salary_max, t.job_salary_currency, '/', t.job_salary_period);
    console.log('employment_type:', t.job_employment_type);
    console.log('description length:', (t.job_description ?? '').length, 'chars');
    console.log('description excerpt:', (t.job_description ?? '').slice(0, 200).replace(/\n/g, ' '));
    console.log('body_for_embedding (first 300 chars):');
    console.log((s.body_for_embedding ?? '').slice(0, 300));
  }

  // 3. Classifier cache size + distribution
  const cacheCount = await sb
    .from('role_classifications')
    .select('family', { count: 'exact', head: true });
  console.log('\n---');
  console.log('role_classifications total cached:', cacheCount.count);

  const byFamily = await sb
    .from('role_classifications')
    .select('family');
  const counts: Record<string, number> = {};
  for (const r of byFamily.data ?? []) counts[r.family as string] = (counts[r.family as string] ?? 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log('cache by family:', sorted);
})();
