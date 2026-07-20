import { createClient } from '@supabase/supabase-js';
import { loadBestContactScore } from '@agent-crm/tools';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const starsling = '60f5a2b3-4879-41a7-9707-a32f48604fb0';
(async () => {
  const best = await loadBestContactScore(db, ws, starsling);
  console.log(`StarSling best_contact_score = ${best}`);
  console.log(best !== undefined && best >= 0.5
    ? `→ LOOP CLOSED: draft gate now sees a reachable contact (>= 0.5). Account no longer routes to enrich_contacts.`
    : `→ still no reachable contact`);
})();
