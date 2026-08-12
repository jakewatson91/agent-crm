/**
 * Price the wasted first attempt. A run whose output_tokens exceed its own cap
 * can only have got there through chatComplete's retry, which re-sends the whole
 * prompt -- so every such run paid for one capped call that produced nothing.
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_PRICING } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const DAYS = Number(process.argv[3] ?? 30);
const SINCE = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
async function pageAll<T>(b:(f:number,t:number)=>any): Promise<T[]> {
  let out:T[]=[],f=0; for(;;){const{data,error}=await b(f,f+999); if(error)throw error; if(!data?.length)break; out=out.concat(data as T[]); if(data.length<1000)break; f+=1000;} return out;
}
const q=(xs:number[],p:number)=>{if(!xs.length)return 0;const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
// The caps as they exist in code today.
const CAP: Record<string, number> = { enricher: 1200, drafter: 3000, scoring: 350, claim_poster: 1200, qualification: 1200 };

(async () => {
  const rows = await pageAll<any>((f,t)=>sb.from('events').select('created_at,payload')
    .eq('action','agent_run_metrics').gte('created_at',SINCE).order('created_at').range(f,t));
  console.log(`window ${DAYS}d — ${rows.length} agent_run_metrics rows\n`);
  const g = new Map<string, {n:number; retried:number; out:number[]; wastedIn:number; wastedOut:number; model:string}>();
  for (const r of rows) {
    const p = r.payload ?? {}; const b = p.behavior ?? '?';
    const cap = CAP[b]; if (!cap || typeof p.output_tokens !== 'number') continue;
    if (!g.has(b)) g.set(b, {n:0,retried:0,out:[],wastedIn:0,wastedOut:0,model:p.model??'?'});
    const e = g.get(b)!; e.n++; e.out.push(p.output_tokens);
    if (p.output_tokens > cap) { e.retried++; e.wastedIn += (p.input_tokens ?? 0); e.wastedOut += cap; }
  }
  console.log('behavior       cap    runs  retried   share    p50   p90   p99   max   suggested cap (p99 rounded up)');
  let totalWasted = 0;
  const lines: string[] = [];
  for (const [b,e] of [...g.entries()].sort((a,b2)=>b2[1].n-a[1].n)) {
    const price = (DEFAULT_PRICING as any).models[e.model] ?? (DEFAULT_PRICING as any).models['deepseek-v4-flash'];
    const cost = (e.wastedIn/1e6)*price.input + (e.wastedOut/1e6)*price.output;
    totalWasted += cost;
    const sugg = Math.ceil(q(e.out,.99)/500)*500;
    console.log(`${b.padEnd(14)}${String(CAP[b]).padStart(5)}${String(e.n).padStart(8)}${String(e.retried).padStart(9)}${((e.retried/e.n)*100).toFixed(1).padStart(7)}% ${String(q(e.out,.5)).padStart(6)}${String(q(e.out,.9)).padStart(6)}${String(q(e.out,.99)).padStart(6)}${String(Math.max(0,...e.out)).padStart(6)}${String(sugg).padStart(10)}`);
    lines.push(`  ${b}: ${e.retried} wasted calls = ${(e.wastedIn/1e6).toFixed(2)}M input + ${(e.wastedOut/1e6).toFixed(2)}M output = $${cost.toFixed(2)}`);
  }
  console.log('\nwasted spend on the thrown-away first attempt:');
  for (const l of lines) console.log(l);
  console.log(`  TOTAL: $${totalWasted.toFixed(2)} / ${DAYS}d  (~$${(totalWasted*30/DAYS).toFixed(2)}/month)`);
  console.log('\nnote: this counts ONLY runs that eventually succeeded. Runs that failed all three');
  console.log('attempts are the agent_llm_failed rows and cost more (three calls, zero output).');
})();
