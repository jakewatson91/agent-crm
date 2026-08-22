import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function fetchAll(table: string, sel: string, mod: (q:any)=>any = q=>q) {
  let out: any[] = []; let from = 0;
  for(;;){ const { data, error } = await mod(sb.from(table).select(sel)).range(from, from+999);
    if (error) { console.error(table, error.message); break; }
    out = out.concat(data ?? []); if (!data || data.length < 1000) break; from += 1000; }
  return out;
}
async function main() {
  const gates = await fetchAll('gates','id,workspace_id,policy,requested_at,decided_by,decision,decided_at,resolution,requested_by_agent');
  console.log('GATES total', gates.length);
  const byWs: Record<string,number> = {}; const byPolicy: Record<string,number> = {}; const byDec: Record<string,number> = {};
  for (const g of gates) { byWs[g.workspace_id.slice(0,8)]=(byWs[g.workspace_id.slice(0,8)]??0)+1; byPolicy[g.policy]=(byPolicy[g.policy]??0)+1; byDec[g.decision??'pending']=(byDec[g.decision??'pending']??0)+1; }
  console.log('by workspace', byWs); console.log('by policy', byPolicy); console.log('by decision', byDec);
  const byMonth: Record<string,any> = {};
  for (const g of gates) { const m=g.requested_at.slice(0,7); byMonth[m]??={}; const k=g.decision??'pending'; byMonth[m][k]=(byMonth[m][k]??0)+1; }
  console.log('gates by month/decision', JSON.stringify(byMonth,null,1));
  const deciders: Record<string,number> = {};
  for (const g of gates) if (g.decided_by) deciders[g.decided_by]=(deciders[g.decided_by]??0)+1;
  console.log('deciders', deciders);
  // resolutions with text (edits)
  const withRes = gates.filter(g=>g.resolution && typeof g.resolution==='object');
  console.log('\ngates with resolution object:', withRes.length);
  for (const g of withRes.slice(-12)) console.log(' ', g.requested_at.slice(0,10), g.policy, g.decision, JSON.stringify(g.resolution).slice(0,300));
}
main();
