/**
 * Drops the `signal_source: yc` filter on the audit_yc_enricher subscription so
 * it catches signals from any source (hn, exa, producthunt, github, web, etc.).
 * Relies on semantic_query + threshold for relevance.
 *
 * Reversible: re-set structured_filter to {"signal_source":"yc"} to restore.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;

  const before = await sb.from('subscriptions')
    .select('id, name, structured_filter')
    .eq('workspace_id', WS)
    .eq('owner_id', 'claims_audit_yc_enricher')
    .single();
  if (before.error || !before.data) throw new Error(`enricher not found: ${before.error?.message}`);
  console.log(`before: ${before.data.name} filter=${JSON.stringify(before.data.structured_filter)}`);

  const upd = await sb.from('subscriptions')
    .update({ structured_filter: {} })
    .eq('id', before.data.id);
  if (upd.error) throw upd.error;

  const after = await sb.from('subscriptions')
    .select('structured_filter').eq('id', before.data.id).single();
  console.log(`after:  ${before.data.name} filter=${JSON.stringify(after.data?.structured_filter)}`);
  console.log('\n✓ enricher will now match any signal (semantic + threshold only).');
  console.log('  next signal cycle will trigger enrichment for hn/exa/etc. sources.');
}
main().catch((e) => { console.error(e); process.exit(1); });
