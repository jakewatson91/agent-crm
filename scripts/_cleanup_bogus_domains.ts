/**
 * Cleanup: CSV-mis-mapped domain values (business sectors like "education")
 * on account attributes. These passed the old normalizeDomain (no dot
 * required) and caused false ATS board matches → junk hiring signals.
 *
 * For each entity whose attributes.domain fails the fixed normalizeDomain:
 *   - null attributes.domain
 *   - drop attributes.ats + attributes.ats_seen_jobs (verification untrustworthy)
 * Then delete hiring signals that were created against those entities by the
 * ATS source (checking facts.signal_id references first).
 *
 * Usage: pnpm exec tsx scripts/_cleanup_bogus_domains.ts [apply]
 * Without "apply" it only reports.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { normalizeDomain } from '../packages/tools/src/ingest.ts';

const APPLY = process.argv[2] === 'apply';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: wss } = await sb.from('workspaces').select('id, name');

  for (const ws of wss ?? []) {
    const bad: Array<{ id: string; name: string; domain: string; hadAts: boolean }> = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await sb.from('entities')
        .select('id, name, attributes')
        .eq('workspace_id', ws.id)
        .not('attributes->>domain', 'is', null)
        .range(from, from + page - 1);
      if (error) throw error;
      for (const e of data ?? []) {
        const attrs = (e.attributes ?? {}) as Record<string, unknown>;
        const raw = String(attrs.domain ?? '');
        if (raw && normalizeDomain(raw) === null) {
          bad.push({ id: e.id, name: e.name, domain: raw, hadAts: !!attrs.ats });
        }
      }
      if ((data ?? []).length < page) break;
    }

    console.log(`\n${ws.name} (${ws.id.slice(0, 8)}): ${bad.length} entities with a non-domain in attributes.domain`);
    for (const b of bad) console.log(`  ${b.name}  domain="${b.domain}"  ats_cached=${b.hadAts}`);
    // Apply only to Sudden: its 10 are all CSV sector strings. Dogfood's hits
    // are social-platform hosts where some entities (Instagram, Facebook, X)
    // actually own that domain — different problem, don't bulk-strip.
    if (!bad.length || !APPLY || !ws.id.startsWith('e7052848')) continue;

    for (const b of bad) {
      const { data: ent } = await sb.from('entities').select('attributes').eq('id', b.id).single();
      const attrs = { ...(ent?.attributes as Record<string, unknown> ?? {}) };
      delete attrs.domain;
      delete attrs.ats;
      delete attrs.ats_seen_jobs;
      const { error } = await sb.from('entities').update({ attributes: attrs }).eq('id', b.id);
      console.log(`  cleaned ${b.name}: ${error ? 'ERROR ' + error.message : 'ok'}`);

      // Hiring signals the ATS source created against this entity are false
      // matches — the board was verified against the bogus domain.
      const { data: sigs } = await sb.from('signals').select('id, structured_tags')
        .eq('workspace_id', ws.id).eq('entity_id', b.id);
      const hiring = (sigs ?? []).filter(s => (s.structured_tags as any)?.kind === 'hiring');
      for (const s of hiring) {
        const { count: factRefs } = await sb.from('facts')
          .select('id', { count: 'exact', head: true }).eq('signal_id', s.id);
        if ((factRefs ?? 0) > 0) {
          console.log(`  signal ${s.id.slice(0, 8)}: ${factRefs} fact(s) reference it — NOT deleted, review manually`);
          continue;
        }
        const { error: delErr } = await sb.from('signals').delete().eq('id', s.id);
        console.log(`  deleted false hiring signal ${s.id.slice(0, 8)}: ${delErr ? 'ERROR ' + delErr.message : 'ok'}`);
      }
    }
  }
  if (!APPLY) console.log('\nDry run. Re-run with "apply" to execute.');
}

main().catch(console.error);
