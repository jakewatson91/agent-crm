/**
 * Does the planner actually succeed for Sudden, or does it fall back to
 * BASELINE_ANGLES? `generateResearchStrategy` is documented pure (no DB write),
 * so this only costs one planner LLM call and changes nothing.
 *
 * Matters because ensureResearchStrategy's baseline branch re-persists the OLD
 * strategy AND restamps strategy_generated_at, so a failing planner is
 * indistinguishable from a successful regeneration by timestamp alone.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { generateResearchStrategy } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const { angles, source, error } = await generateResearchStrategy(sb, WS);
  console.log('source:', source, error ? `| error: ${error}` : '');
  console.log(`angles returned: ${angles.length}`);
  for (const a of angles) console.log(`  ${String(a.id).padEnd(30)} scope=${String(a.domain_scope).padEnd(9)} answers=${a.answers ?? '(none)'}\n      ${a.query_template}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
