/**
 * Step 8: the gate call at the PRODUCTION budget with no JSON retry, on a real
 * single-account candidate batch. Distinguishes two failure modes:
 *   A. response truncates -> JSON.parse throws -> catch -> own-domain accepted
 *      unjudged, off-domain dropped as "unreported"
 *   B. response parses but the model omits rejects[] -> every non-match counted
 *      "unreported" with no reason
 * Also reports how many matches carry a hook class, since an unclassified accept
 * keeps full signal magnitude.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const ACCOUNT = process.argv[2] ?? 'ViX';
const BUDGETS = [1200, 4000];

const pains = [
  'Popular titles are watched by a lot of people at the same time, and every one of those views ships the same bytes again',
  'On ad-funded catalogue, delivery comes out of a fixed yield per view, so more views can mean less margin',
  'Traffic grows faster than the delivery team, so the cost line has no owner',
];
const signalTypes = ['CDN cost increases', 'video infrastructure optimization searches', 'scaling streaming platform'];

function buildSys(name: string, domain: string, context: string): string {
  return `You verify whether a web page is (a) about a SPECIFIC target company, (b) substantive enough to be worth reading, and (c) relevant to what a specific seller offers.

TARGET COMPANY:
- name: ${name}
- website: ${domain || '(unknown)'}
- about: ${context || '(nothing known)'}

A page is a MATCH only if ALL THREE hold:
1. It is about THIS company. A page hosted on the target's own website is by definition this company — treat condition 1 as satisfied for it and judge it on the remaining conditions only. When genuinely unsure AND the page clearly fits the target's description, lean toward matching.
2. It carries substantive content: news, a launch, a blog post, a case study, an interview, a partnership, a review with real detail. Directory listings, tool aggregators, company-profile pages, and databases that merely restate name + category + description are NOT a match.
3. It carries a signal RELEVANT to what this seller offers. The seller helps companies with: ${pains.join('; ')}. They watch for these triggers: ${signalTypes.join('; ')}.
   A page is relevant if its content plausibly connects to that problem area. A page about the right company but a clearly unrelated topic is NOT relevant.

For each matching page, also classify what kind of hook it carries: "event", "direction", or "profile".

Return JSON only:
{"matches":[{"id":"<id>","class":"event"|"direction"|"profile"}, ...],
 "rejects":[{"id":"<id>","failed":"identity"|"substance"|"relevance"}, ...]}

"matches" holds one entry per page that passes all three tests. "rejects" holds every other page, naming the FIRST test it failed. Every page you were given must appear in exactly one of the two lists.`;
}

(async () => {
  const ent = (await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).ilike('name', ACCOUNT).limit(1).maybeSingle()).data as any;
  if (!ent) { console.log(`no account named ${ACCOUNT}`); return; }
  const domain = (ent.attributes?.domain ?? '').toLowerCase();
  const sigs = (await sb.from('signals').select('structured_tags, body_for_embedding')
    .eq('workspace_id', WS).eq('entity_id', ent.id).eq('type', 'research_result')
    .order('observed_at', { ascending: false }).limit(40)).data ?? [];
  const batch = sigs.map((s: any) => ({
    id: s.structured_tags?.exa_id ?? s.structured_tags?.url,
    url: s.structured_tags?.url as string,
    title: (s.body_for_embedding ?? '').split('\n')[0] ?? '',
    text: (s.body_for_embedding ?? '').slice(0, 500),
  })).filter((p: any) => p.id && p.url);
  console.log(`account: ${ent.name} (${domain})  real stored candidates: ${batch.length}\n`);

  const sys = buildSys(ent.name, domain, `${ent.name} — streaming service.`);
  const payload = JSON.stringify(batch);

  for (const budget of BUDGETS) {
    const llm = await chatComplete({
      model: 'deepseek-v4-flash', max_tokens: budget, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: payload }],
    });
    let parsed: any = null; let err = '';
    try { parsed = JSON.parse(llm.text); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    const matches = parsed?.matches ?? [];
    const rejects = parsed?.rejects ?? [];
    const classed = matches.filter((m: any) => m && typeof m === 'object' && m.class).length;
    const bare = matches.filter((m: any) => typeof m === 'string').length;
    console.log(`--- max_tokens=${budget} ---`);
    console.log(`  finish=${llm.finish_reason} out_tokens=${llm.output_tokens} parsed=${parsed ? 'YES' : 'NO (' + err.slice(0, 50) + ')'}`);
    console.log(`  matches=${matches.length} (classed=${classed}, bare-string=${bare})  rejects=${rejects.length}  accounted=${matches.length + rejects.length}/${batch.length}`);
    if (parsed && matches.length + rejects.length < batch.length) {
      console.log(`  >>> MODE B: ${batch.length - matches.length - rejects.length} pages the model never mentioned -> counted "unreported"`);
    }
    if (!parsed) console.log(`  >>> MODE A: catch fires. own-domain pages accepted UNJUDGED, off-domain dropped.`);
    for (const m of matches.slice(0, 6)) console.log(`     MATCH ${typeof m === 'string' ? m + ' (no class)' : `${m.class ?? 'NO CLASS'}  ${String(m.id).slice(0, 80)}`}`);
  }
})();
