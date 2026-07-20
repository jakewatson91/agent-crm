import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const full='ed3f4443-acc6-4394-a4e1-ab94f90b66bf';
(async()=>{
  for (const pred of ['icp_fit','score_total']) {
    const { data } = await sb.from('facts').select('id, object_text, supersedes, observed_at, created_at').eq('subject_entity',full).eq('predicate',pred).order('observed_at',{ascending:false});
    const rows=(data??[]);
    const pointedTo = new Set(rows.map(r=>r.supersedes).filter(Boolean));
    console.log(`\n${pred}: ${rows.length} rows total`);
    for (const r of rows.slice(0,6)) {
      const active = r.supersedes===null ? 'supersedes=NULL' : `supersedes=${String(r.supersedes).slice(0,8)}`;
      const isActive = !pointedTo.has(r.id);
      console.log(`  ${isActive?'ACTIVE':'      '} id=${r.id.slice(0,8)} val=${r.object_text} obs=${r.observed_at?.slice(0,19)} ${active}`);
    }
    console.log(`  -> # active (not pointed-to) = ${rows.filter(r=>!pointedTo.has(r.id)).length};  # supersedes=NULL = ${rows.filter(r=>r.supersedes===null).length}`);
  }
})();
