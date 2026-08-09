/**
 * A/B the relevance gate on REAL stored pages. No Exa spend — the candidates are
 * research_result signals already in the book, which is exactly the material the
 * old gate let through.
 *
 * Prints a per-page verdict so "was this drop correct" is answerable by reading,
 * not by trusting a count.
 *
 * Usage: pnpm tsx scripts/_gq_11_gateab.ts "ViX" [more accounts...]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { filterResultsByEntity, resolveBrief, getPolicy } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const ACCOUNTS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

(async () => {
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy);
  console.log('BRIEF:');
  for (const q of brief) console.log(`  [${q.id}] ${q.question.slice(0, 110)}`);
  console.log('');

  let totalKept = 0, totalPages = 0;
  const dropTotals: Record<string, number> = {};

  for (const name of ACCOUNTS) {
    const ent = (await sb.from('entities').select('id, name, attributes')
      .eq('workspace_id', WS).ilike('name', name).limit(1).maybeSingle()).data as any;
    if (!ent) { console.log(`!! no account named ${name}`); continue; }
    const domain = (ent.attributes?.domain ?? '').toLowerCase();

    const sigs = (await sb.from('signals').select('structured_tags, body_for_embedding')
      .eq('workspace_id', WS).eq('entity_id', ent.id).eq('type', 'research_result')
      .order('observed_at', { ascending: false }).limit(40)).data ?? [];
    const pages = sigs.map((s: any) => ({
      id: (s.structured_tags?.exa_id ?? s.structured_tags?.url) as string,
      url: s.structured_tags?.url as string,
      title: ((s.body_for_embedding ?? '').split('\n')[0] ?? '').slice(0, 140),
      text: (s.body_for_embedding ?? '').slice(0, 600),
    })).filter((p: any) => p.id && p.url);
    if (!pages.length) { console.log(`!! ${ent.name}: no stored research pages`); continue; }

    const context = `${ent.name} — ${(ent.attributes?.description ?? ent.attributes?.industry ?? 'company')}`;
    const res = await filterResultsByEntity({ name: ent.name, domain, context, brief }, pages);

    totalPages += pages.length; totalKept += res.accepted.size;
    for (const [k, v] of Object.entries(res.droppedBy)) dropTotals[k] = (dropTotals[k] ?? 0) + v;

    console.log(`\n=== ${ent.name} (${domain}) — ${pages.length} stored pages ===`);
    console.log(`kept ${res.accepted.size}  dropped ${res.dropped}  ${JSON.stringify(res.droppedBy)}  unreadable_batches=${res.unreadable_batches}`);
    for (const p of pages) {
      const kept = res.accepted.has(p.id);
      const mark = kept ? 'KEEP' : 'drop';
      const detail = kept
        ? `${(res.answersById.get(p.id) ?? '-').padEnd(22)} ${res.classById.get(p.id) ?? '-'}`
        : `${(res.rejectReasonById.get(p.id) ?? '?').padEnd(22)}`;
      console.log(`  ${mark}  ${detail}  ${p.url.slice(0, 105)}`);
    }
  }

  console.log(`\n\nTOTAL: kept ${totalKept} of ${totalPages} stored pages (${((totalKept / totalPages) * 100).toFixed(0)}%)`);
  console.log(`drops by reason: ${JSON.stringify(dropTotals)}`);
})();
