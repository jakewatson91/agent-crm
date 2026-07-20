import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { ADMIN_PREDICATES, isSubstantiveFact } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const full='ed3f4443-acc6-4394-a4e1-ab94f90b66bf';
(async()=>{
  const { data } = await sb.from('facts').select('predicate, object_text, observed_at, created_at').eq('subject_entity',full).is('supersedes',null).order('observed_at',{ascending:false});
  const facts=(data??[]);
  console.log('active facts:', facts.length);
  console.log('ADMIN_PREDICATES:', [...ADMIN_PREDICATES].join(','));
  const top40 = facts.slice(0,40);
  const scoreTotal = top40.find(f=>f.predicate==='score_total');
  console.log('\nscore_total in top-40?', !!scoreTotal, scoreTotal? 'observed='+scoreTotal.observed_at?.slice(0,19):'');
  const icp = facts.find(f=>f.predicate==='icp_fit');
  console.log('icp_fit observed=', icp?.observed_at?.slice(0,19));
  if (scoreTotal){
    const scoreTs=Date.parse(scoreTotal.observed_at);
    const newerSub = top40.filter(f=>!ADMIN_PREDICATES.has(f.predicate) && Date.parse(f.observed_at)>scoreTs);
    console.log('substantive facts newer than score_total in top40:', newerSub.length);
    console.log('  -> skip-when-stale fires if this is 0');
  }
  console.log('\ntop 15 facts (pred / observed / substantive):');
  for (const f of facts.slice(0,15)) console.log(`  ${f.predicate.padEnd(24)} ${f.observed_at?.slice(0,19)} sub=${isSubstantiveFact(f.predicate)}`);
})();
