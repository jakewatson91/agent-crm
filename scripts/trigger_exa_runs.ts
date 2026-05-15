/**
 * Send source.run events for every active Exa source so they run now rather
 * than waiting for the next 6h cron tick. Use after topping up Exa credits
 * (or any time you want to force a fresh run).
 *
 * Optionally pass --type=<connector> to target a different connector type
 * (e.g. --type=web).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { Inngest } from 'inngest';

async function main() {
  const args = process.argv.slice(2);
  const typeArg = args.find((a) => a.startsWith('--type='))?.slice(7) ?? 'exa';

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const eventKey = process.env.INNGEST_EVENT_KEY;
  if (!eventKey) { console.error('INNGEST_EVENT_KEY missing from .env.local'); process.exit(1); }
  const inngest = new Inngest({ id: 'agent-crm-trigger', eventKey });

  const r = await sb.from('sources')
    .select('id, workspace_id, name, connector_type, active')
    .eq('connector_type', typeArg)
    .eq('active', true);
  if (r.error) { console.error(r.error.message); process.exit(1); }
  const sources = (r.data ?? []) as Array<{ id: string; workspace_id: string; name: string; connector_type: string; active: boolean }>;

  if (!sources.length) { console.log(`No active ${typeArg} sources to trigger.`); return; }

  console.log(`Triggering ${sources.length} ${typeArg} source(s):`);
  for (const s of sources) console.log(`  - ${s.name} (${s.id.slice(0, 8)})`);

  await inngest.send(sources.map((s) => ({
    name: 'source.run' as const,
    data: { source_id: s.id, workspace_id: s.workspace_id },
  })));

  console.log(`\nDispatched. Check Inngest dashboard or rerun "pnpm sweep" in ~2 min.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
