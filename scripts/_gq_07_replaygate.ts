/**
 * Step 7: reproduce the relevance-gate failure directly.
 *
 * Rebuilds a realistic candidate batch out of STORED research signals (no Exa
 * spend), runs the exact prompt filterResultsByEntity builds, and reports
 * finish_reason, output tokens, whether the JSON parsed, and how many of the
 * input pages the model actually accounted for.
 *
 * Usage: pnpm tsx scripts/_gq_07_replaygate.ts <batch_size> [batch_size...]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const SIZES = (process.argv.slice(2).map(Number).filter(Boolean).length ? process.argv.slice(2).map(Number).filter(Boolean) : [10, 20, 30, 40]);
const MODEL = process.env.GQ_MODEL ?? 'deepseek-v4-flash';

const target = {
  name: 'Sky Stream',
  domain: 'sky.com',
  context: 'Sky Stream — streaming TV service delivering shows, movies and live sport over the internet without a satellite dish.',
  pains: [
    'Popular titles are watched by a lot of people at the same time, and every one of those views ships the same bytes again',
    'On ad-funded catalogue, delivery comes out of a fixed yield per view, so more views can mean less margin',
    'Traffic grows faster than the delivery team, so the cost line has no owner',
  ],
  signal_types: ['CDN cost increases', 'video infrastructure optimization searches', 'scaling streaming platform'],
};

function buildSys(): string {
  const relevanceCondition = `\n3. It carries a signal RELEVANT to what this seller offers. The seller helps companies with: ${target.pains.join('; ')}. They watch for these triggers: ${target.signal_types.join('; ')}.
   A page is relevant if its content plausibly connects to that problem area — the company growing or scaling in a way that drives it, a person there discussing it, a change that creates or reveals the need, or how the company runs the systems involved. A page about the right company but a clearly unrelated topic (a different part of the business with no bearing on that problem) is NOT relevant. Judge the connection by meaning, not keywords: "expanding to new regions" or "scaling to more users" counts even when none of the exact terms above appear.`;
  return `You verify whether a web page is (a) about a SPECIFIC target company, (b) substantive enough to be worth reading, and (c) relevant to what a specific seller offers.

TARGET COMPANY:
- name: ${target.name}
- website: ${target.domain}
- about: ${target.context}

A page is a MATCH only if ALL THREE hold:
1. It is about THIS company (the one at that website / fitting that description). A company in a different industry, sector, or country that happens to share the name is NOT a match. A page hosted on the target's own website is by definition this company — treat condition 1 as satisfied for it and judge it on the remaining conditions only. When genuinely unsure AND the page clearly fits the target's description, lean toward matching.
2. It carries substantive content: news, a launch, a blog post, a case study, an interview, a partnership, a review with real detail. Directory listings, tool aggregators, company-profile pages, and databases that merely restate name + category + description are NOT a match even when they're about the right company — they contain nothing we don't already know.${relevanceCondition}

For each matching page, also classify what kind of hook it carries:
- "event": something dated HAPPENED — a launch, expansion, deal, published number, hire, or a person there saying something tied to a moment (a post, talk, interview).
- "direction": evidence of a current priority or push — what the company keeps working toward or says it is doing next, without one dated event.
- "profile": describes what the company is or does — confirms it fits a market but reports nothing new happening. These are the least valuable; be honest when a page is only this.

Return JSON only:
{"matches":[{"id":"<id>","class":"event"|"direction"|"profile"}, ...],
 "rejects":[{"id":"<id>","failed":"identity"|"substance"|"relevance"}, ...]}

"matches" holds one entry per page that passes all three tests. "rejects" holds every other page, naming the FIRST test it failed — "identity" for test 1, "substance" for test 2, "relevance" for test 3. Every page you were given must appear in exactly one of the two lists.`;
}

(async () => {
  const sigs = (await sb.from('signals')
    .select('structured_tags, body_for_embedding')
    .eq('workspace_id', WS).eq('type', 'research_result')
    .order('observed_at', { ascending: false }).limit(60)).data ?? [];
  const pool = sigs
    .map((s: any) => ({ id: s.structured_tags?.exa_id ?? s.structured_tags?.url, url: s.structured_tags?.url as string, title: (s.body_for_embedding ?? '').split('\n')[0] ?? '', text: (s.body_for_embedding ?? '').slice(0, 600) }))
    .filter((p) => p.id && p.url);
  console.log(`candidate pool rebuilt from stored signals: ${pool.length}`);
  console.log(`model: ${MODEL}\n`);

  const sys = buildSys();
  for (const n of SIZES) {
    const batch: any[] = [];
    while (batch.length < n && pool.length) batch.push(pool[batch.length % pool.length]);
    const payload = JSON.stringify(batch.map((r) => ({ id: r.id, title: r.title, url: r.url, text: (r.text ?? '').slice(0, 500) })));
    // Deliberately NOT going through chatComplete's json retry — we want to see
    // what the FIRST call at the production budget does.
    const t0 = Date.now();
    const llm = await chatComplete({
      model: MODEL, max_tokens: 1200, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: payload }],
    });
    let parsed: any = null; let parseErr = '';
    try { parsed = JSON.parse(llm.text); } catch (e) { parseErr = e instanceof Error ? e.message : String(e); }
    const accounted = parsed ? (parsed.matches?.length ?? 0) + (parsed.rejects?.length ?? 0) : 0;
    const withClass = parsed ? (parsed.matches ?? []).filter((m: any) => m && typeof m === 'object' && m.class).length : 0;
    console.log(`batch=${String(n).padStart(3)}  in=${String(llm.input_tokens).padStart(5)} out=${String(llm.output_tokens).padStart(5)} finish=${String(llm.finish_reason).padEnd(10)} parsed=${parsed ? 'YES' : 'NO '} accounted=${accounted}/${n} classed=${withClass} chars=${llm.text.length} ${Date.now() - t0}ms ${parseErr ? '| ' + parseErr.slice(0, 60) : ''}`);
    if (!parsed) console.log(`      tail: ...${llm.text.slice(-90).replace(/\n/g, ' ')}`);
  }
})();
