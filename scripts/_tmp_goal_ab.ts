/**
 * TEMP research script (delete after): does the 18k-char craft block earn its
 * place? Same account, same anchor, same argument, same model — one draft from
 * the live prompt, one from a thin prompt that keeps only the rules a good
 * model cannot infer. Writes NOTHING.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { appendFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace, fetchAll, scoreFacts, pickDraftAngle, resolveMaxOutputTokens, pickAnchorCandidates, cannotWriteAbout, type AngleDecision } from '@agent-crm/tools';
import { buildSystemPrompt, buildUserPrompt } from '../inngest/functions/agent_logic.js';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const OUT = process.env.AB_OUT ?? '/tmp/ab_drafts.txt';
function log(s: string) { appendFileSync(OUT, s + '\n'); console.log(s); }

const BANNED_CTA = [/open to a (quick |brief )?(chat|call)/i, /worth a (quick )?(chat|call)/i, /\b15 minutes\b/i, /can we sync/i, /https?:\/\//i,
  /\bworth (a look|exploring|connecting|a conversation)\b/i, /\b(one[- ]pager|a deck|brochure|collateral|white ?paper)\b/i];
const FEELINGS = 'worried|concerned|anxious|frustrated|nervous|excited|afraid|scared|stressed|keen|desperate';
const MIND_READ = [new RegExp(`\\byou(?:'re| are|r team is)?\\s+(?:probably\\s+|clearly\\s+)?(?:${FEELINGS})\\b`,'i'), /\byou must be\b/i, /\bkeeping you up at night\b/i];
const FILLER = /\b(streamline|leverage|optimize|empower|unlock|revolutioni[sz]e|seamless|all-in-one|single source of truth)\b/i;
const DASH = /[—–]|\s-\s/;
function grade(body: string) {
  const f: string[] = [];
  if (BANNED_CTA.some(r=>r.test(body))) f.push('banned-cta');
  if (MIND_READ.some(r=>r.test(body))) f.push('mind-read');
  if (FILLER.test(body)) f.push('filler');
  if (DASH.test(body)) f.push('dash');
  return f;
}

function thinPrompt(about: string, constitution: string, arg: any, freshDays: number, paraCount: number) {
  return `You are an outbound-email drafter.

ABOUT THIS COMPANY (what we sell, who we sell to):
${about}

WORKSPACE CONSTITUTION (voice and hard rules, these win over everything below):
${constitution}

THE EVENT THIS MESSAGE IS ABOUT is given in the user message. It was chosen for you: open on it, cite it, do not go looking for a better one.

THE ARGUMENT YOU ARE MAKING. It was matched to this account before you saw this prompt. Do not re-derive it and do not reach a different conclusion, however reasonable the other one seems.
  BECAUSE THIS HAPPENED: ${arg.when}
  WHAT IT COSTS THEM:    ${arg.so}
  WHAT YOU ARE ASKING:   ${arg.ask}

Write ${paraCount} short paragraphs to the account. Open on what they did and what it costs them. Ask one question they can answer from memory, before you say anything about what you sell. Say in one plain sentence what the thing you sell does. Close by asking for exactly what the argument asks for and nothing wider.

HARD RULES
- Never invent a number, a customer name, a case study or a result.
- Never name an internal field or say where the data came from. Write as a person who researched them on the open web.
- Never tell them what they think, feel or worry about.
- No links. No dashes standing in for a comma. No exclamation marks.
- Use a first name only if a named contact is in the user message. Otherwise write no greeting at all and never invent a name.
- Never ask for time: no "open to a quick chat", no "worth a look", no proposed meeting, no calendar link.
- If nothing in the facts shows what the event costs them, stop and output request_gate instead of substituting a different argument.
- An event older than ${freshDays} days must not be written about as if it just happened.

Output strictly valid JSON, no preamble:
{"action":"post_touch_draft","subject":"<one concrete word>","body":"<${paraCount} short paragraphs separated by blank lines>","cites":["<fact_id_uuid>",...],"cite_quotes":[{"fact_id":"<uuid>","quote":"<exact phrase from body>"}],"reasoning":"<anchor + why this recipient>","to_email":"<picked contact email or null>"}
Or, to refuse: {"action":"request_gate","body":"<the one missing fact you would need>","policy":"facts_insufficient_for_draft"}`;
}

async function main() {
  writeFileSync(OUT, '');
  const limit = Number(process.argv[2] ?? 6);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: w } = await sb.from('workspaces').select('about, constitution, persona, icp, policy').eq('id', WS).single();
  const ws = w as any; const policy = (ws.policy ?? {}) as any;
  const args = policy.drafter?.arguments ?? [];

  const scoreRows = await fetchAll<any>((from, to) => sb.from('facts')
    .select('id, subject_entity, object_text, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'score_total').order('id').range(from, to));
  const superseded = new Set(scoreRows.map(r=>r.supersedes).filter(Boolean));
  const ranked = scoreRows.filter(r=>!superseded.has(r.id))
    .map(r=>({ entity_id: r.subject_entity as string, score: parseFloat(r.object_text ?? '') }))
    .filter(r=>Number.isFinite(r.score)).sort((a,b)=>b.score-a.score);

  let done = 0;
  const tally = { A: { tok:0, flags:0, gate:0, chars:0 }, B: { tok:0, flags:0, gate:0, chars:0 } };
  for (const row of ranked) {
    if (done >= limit) break;
    const { data: ent } = await sb.from('entities').select('id, name, attributes').eq('id', row.entity_id).maybeSingle();
    if (!ent) continue;
    const acct: any = { ...(ent as any), score: row.score };
    const { data: allFacts } = await sb.from('facts')
      .select('id, predicate, object_text, confidence, observed_at, happened_at, signal_id, supersedes')
      .eq('workspace_id', WS).eq('subject_entity', acct.id);
    const factRows = (allFacts ?? []) as any[];
    const pointed = new Set(factRows.map(f=>f.supersedes).filter(Boolean));
    const activeFacts = factRows.filter(f=>!pointed.has(f.id) && !f.predicate.startsWith('score_') &&
      !['icp_fit','icp_fit_breakdown','contact_score','dropped_until','outreach_cooldown_until'].includes(f.predicate));
    if (!activeFacts.length) continue;

    const anchorPick = pickAnchorCandidates({
      facts: activeFacts.map((f:any)=>({ id:f.id, predicate:f.predicate, object_text:f.object_text, happened_at:f.happened_at ?? null })),
      freshDays: policy.drafter?.trigger_fresh_days,
    });
    const decision: AngleDecision = await pickDraftAngle(sb as any, WS, {
      model: 'deepseek-v4-flash', account_name: acct.name,
      facts: activeFacts.map((f:any)=>({ id:f.id, predicate:f.predicate, object_text:f.object_text })),
      pain_points: policy.drafter?.pain_points ?? [], templates: policy.drafter?.templates ?? [],
      arguments: args, out_of_scope: cannotWriteAbout(policy.drafter),
    } as any);
    const outOfScopeIds = decision.out_of_scope_fact_ids ?? [];
    const writable = anchorPick.candidates.filter(c=>!outOfScopeIds.includes(c.id));
    const leadAnchor = writable[0];
    if (!leadAnchor) continue;
    const angle = decision.choice as any;
    if (!angle?.argument) { log(`── ${acct.name}: no argument matched (${decision.reason}), skipping\n`); continue; }

    let recommended: any[] = [];
    try { recommended = await scoreFacts(sb as any, { workspace_id: WS, entity_id: acct.id, facts: activeFacts as any, limit: 5 } as any); } catch {}
    const shortlist = outOfScopeIds.length ? recommended.filter(r=>!outOfScopeIds.includes(r.id)) : recommended;
    const { data: sig } = await sb.from('signals').select('*').eq('entity_id', acct.id).order('observed_at',{ascending:false}).limit(1).maybeSingle();
    const user = buildUserPrompt('claims_outbound_drafter','ab','ab grading pass', sig ?? {},
      { id: acct.id, name: acct.name, attributes: acct.attributes }, activeFacts, [], [], shortlist as any, true, outOfScopeIds, leadAnchor);

    const sysA = buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
      outreach_channel: policy.drafter?.outreach_channel, pain_points: policy.drafter?.pain_points,
      value_props: policy.drafter?.value_props, forbidden_phrases: policy.outreach?.banned_phrases ?? [],
      forbidden_field_terms: policy.drafter?.forbidden_field_terms ?? [], paragraph_count: policy.drafter?.paragraph_count,
      subject_style: policy.drafter?.subject_style, trigger_fresh_days: policy.drafter?.trigger_fresh_days,
      out_of_scope: policy.drafter?.out_of_scope, angle: { problem: angle.problem, argument: angle.argument },
    } as any);
    const sysB = thinPrompt(ws.about, ws.constitution, angle.argument, policy.drafter?.trigger_fresh_days ?? 30, policy.drafter?.paragraph_count ?? 4);

    log(`\n${'='.repeat(78)}\n${acct.name}  score=${Number(acct.score).toFixed(2)}  anchor: ${String(leadAnchor.object_text).slice(0,80)} (${String(leadAnchor.happened_at).slice(0,10)})`);
    log(`prompt A ${sysA.length} chars | prompt B ${sysB.length} chars`);
    for (const [tag, sys] of [['A', sysA], ['B', sysB]] as const) {
      const t0 = Date.now();
      let res: any;
      try {
        res = await Promise.race([
          chatCompleteForWorkspace(sb as any, WS, {
            model: 'deepseek-v4-pro', behavior: 'drafter', max_tokens: resolveMaxOutputTokens(policy,'drafter'),
            response_format: { type: 'json_object' }, messages: [{role:'system',content:sys},{role:'user',content:user}],
          } as any),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout 300s')), 300000)),
        ]);
      } catch (e:any) { log(`  [${tag}] CALL FAILED after ${((Date.now()-t0)/1000).toFixed(0)}s: ${e.message?.slice(0,150)}`); continue; }
      const secs = ((Date.now()-t0)/1000).toFixed(0);
      let p: any; try { p = JSON.parse(String(res.text ?? '').replace(/^```json\s*|\s*```$/g,'').trim()); }
      catch { log(`  [${tag}] UNPARSEABLE`); continue; }
      const t = tally[tag]; t.tok += Number(res.output_tokens ?? 0);
      if (p.action === 'request_gate') { t.gate++; log(`  [${tag}] ${secs}s GATE: ${p.body}`); continue; }
      const flags = grade(String(p.body ?? ''));
      t.flags += flags.length; t.chars += String(p.body ?? '').length;
      log(`  [${tag}] ${secs}s | ${Number(res.output_tokens ?? 0)} out tok | ${String(p.body??'').length} chars | flags: ${flags.join(',') || 'none'}`);
      log(`      SUBJ: ${p.subject}`);
      log(String(p.body ?? '').split('\n').map(l=>'      '+l).join('\n'));
    }
    done++;
  }
  log(`\n${'='.repeat(78)}\nTALLY over ${done} accounts`);
  log(`  A (live, full craft): ${tally.A.tok} out tok, ${tally.A.gate} gates, ${tally.A.flags} rule flags, avg body ${Math.round(tally.A.chars/Math.max(done-tally.A.gate,1))} chars`);
  log(`  B (thin prompt)     : ${tally.B.tok} out tok, ${tally.B.gate} gates, ${tally.B.flags} rule flags, avg body ${Math.round(tally.B.chars/Math.max(done-tally.B.gate,1))} chars`);
}
main();
