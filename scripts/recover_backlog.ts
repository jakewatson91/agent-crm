/**
 * Recover the unmatched-signal backlog by emitting signal.created events directly
 * to Inngest's event API. Bypasses the broken pg_net trigger.
 *
 * Idempotent at the matcher layer: subscription.matched is content-deduped per signal.
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
  const eventKey = process.env.INNGEST_EVENT_KEY;
  if (!eventKey) throw new Error('INNGEST_EVENT_KEY not set');

  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;

  // Find signals with no subscription.matched event
  const sigs = await sb.from('signals')
    .select('id, entity_id, type, observed_at')
    .eq('workspace_id', WS)
    .order('created_at', { ascending: false })
    .limit(500);
  const sigRows = (sigs.data ?? []) as Array<{ id: string; entity_id: string; type: string; observed_at: string }>;

  // Scope to candidate signals (target_id IS the signal_id) so we don't hit
  // PostgREST's 1000-row cap and treat already-matched signals as unmatched.
  const sigIds = sigRows.map((s) => s.id);
  const matched = await sb.from('events').select('target_id')
    .eq('workspace_id', WS).eq('action', 'subscription.matched')
    .in('target_id', sigIds);
  const matchedSet = new Set<string>(
    ((matched.data ?? []) as Array<{ target_id: string | null }>)
      .map((e) => e.target_id)
      .filter((id): id is string => Boolean(id)),
  );
  const unmatched = sigRows.filter((s) => !matchedSet.has(s.id));
  console.log(`unmatched signals: ${unmatched.length} of ${sigRows.length}`);
  if (!unmatched.length) return;

  const url = `https://inn.gs/e/${eventKey}`;
  let sent = 0; let failed = 0;
  for (const s of unmatched) {
    const payload = {
      name: 'signal.created',
      data: { signal_id: s.id, workspace_id: WS, entity_id: s.entity_id, type: s.type, observed_at: s.observed_at },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) sent++; else { failed++; if (failed <= 3) console.log(`  failed ${s.id.slice(0, 8)}: ${res.status} ${await res.text()}`); }
  }
  console.log(`✓ sent=${sent} failed=${failed}`);
  console.log('match-signal will fan out subscription.matched events; agent.run will follow.');
}
main().catch((e) => { console.error(e); process.exit(1); });
