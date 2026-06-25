/**
 * One-time: rename the internal `candidate` attribute flag to `_candidate` on
 * existing entities, so it follows the `_`-prefix convention for internal
 * bookkeeping and drops out of the human attributes grid. The scoring gate
 * (skip thin candidate nodes) now reads `_candidate`, so this must run for the
 * gate to keep working on already-created stubs.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchAll } from '../packages/tools/src/paginate.ts';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const rows = await fetchAll<{ id: string; attributes: Record<string, unknown> }>((from, to) =>
    sb.from('entities').select('id, attributes').order('id', { ascending: true }).range(from, to),
  );

  const toFix = rows.filter((r) => r.attributes && Object.prototype.hasOwnProperty.call(r.attributes, 'candidate'));
  console.log(`scanned ${rows.length} entities; ${toFix.length} have a top-level 'candidate' key`);

  let updated = 0, failed = 0;
  for (const r of toFix) {
    const attrs = { ...r.attributes };
    if (!('_candidate' in attrs)) attrs._candidate = attrs.candidate;
    delete attrs.candidate;
    const { error } = await sb.from('entities').update({ attributes: attrs }).eq('id', r.id);
    if (error) { failed++; console.error(`  fail ${r.id.slice(0, 8)}: ${error.message}`); }
    else updated++;
  }
  console.log(`done: ${updated} updated, ${failed} failed`);

  // sanity: confirm none remain
  const after = await fetchAll<{ id: string }>((from, to) =>
    sb.from('entities').select('id').not('attributes->candidate', 'is', null).order('id', { ascending: true }).range(from, to),
  ).catch(() => []);
  console.log(`remaining with 'candidate': ${after.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
