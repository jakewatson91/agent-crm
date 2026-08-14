/**
 * Dry-run the drafter against real Sudden accounts.
 *
 * Uses the exact system + user prompts the live drafter builds, calls the same
 * model through the same wrapper, and prints the result. Writes NOTHING: no
 * channel_posts, no events, no contact pulls, no credit burn beyond the
 * completion itself. This is how we grade the craft rules before any draft goes
 * near a send approval.
 *
 * Usage: pnpm tsx scripts/_dryrun_drafts.ts [count]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace, scoreFacts, pickDraftAngle, resolveMaxOutputTokens, type AngleDecision } from '@agent-crm/tools';
import { buildSystemPrompt, buildUserPrompt } from '../inngest/functions/agent_logic.js';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const OUT = process.env.DRYRUN_OUT ?? '/tmp/sudden_dryrun.txt';

// DRYRUN_ANGLE_CACHE pins the picked problem across runs. Without it, comparing
// two prompt or model settings compares two things at once: the angle picker is
// its own LLM call and it hands different runs different problems, so a draft
// that turned into a refusal can be the picker's doing rather than the change
// under test. First run with the file absent writes its picks; every later run
// pointed at the same file reuses them. Delete the file to re-pick.
const ANGLE_CACHE = process.env.DRYRUN_ANGLE_CACHE ?? '';
const angleCache = new Map<string, AngleDecision>(
  ANGLE_CACHE && existsSync(ANGLE_CACHE) ? JSON.parse(readFileSync(ANGLE_CACHE, 'utf8')) : [],
);

// Node buffers stdout to a pipe, so a long run shows nothing until it exits.
// Append to a file instead so progress is readable while it runs.
function log(s: string) { appendFileSync(OUT, s + '\n'); console.log(s); }

// CTAs the craft rules ban outright, plus the claims the constitution keeps out
// of a first message. Grepped mechanically so grading isn't a vibe check.
const BANNED_CTA = [/open to a (quick |brief )?(chat|call)/i, /worth a (quick )?(chat|call)/i, /\b15 minutes\b/i, /can we sync/i, /https?:\/\//i];
const BANNED_CLAIM = [/60\s*(-|to|–)\s*80/i, /pay only from savings/i, /no savings,? no fee/i, /only get paid/i];
const FILLER = /\b(streamline|leverage|optimize|empower|unlock|revolutioni[sz]e|seamless|all-in-one|single source of truth)\b/i;

async function main() {
  writeFileSync(OUT, "");
  const limit = Number(process.argv[2] ?? 8);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data: w } = await sb.from('workspaces').select('about, constitution, persona, icp, policy').eq('id', WS).single();
  const ws = w as any;
  const policy = (ws.policy ?? {}) as any;

  // The system prompt is now built per account, not once for the batch: the
  // angle picker runs first and its answer changes which exemplars render. See
  // buildSystem below, called inside the loop the way the live drafter does it.
  const buildSystem = (angle: AngleDecision['choice']) => buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
    outreach_channel: policy.drafter?.outreach_channel,
    pain_points: policy.drafter?.pain_points,
    value_props: policy.drafter?.value_props,
    tone_keywords: policy.drafter?.tone_keywords,
    forbidden_phrases: policy.outreach?.banned_phrases ?? [],
    forbidden_field_terms: policy.drafter?.forbidden_field_terms ?? [],
    templates: policy.drafter?.templates,
    angle: angle ? { problem: angle.problem, withheld_template_ids: angle.withheld_template_ids } : undefined,
    message_rules: policy.drafter?.message_rules,
    char_budget: policy.drafter?.char_budget,
    trigger_max_age_days: policy.drafter?.trigger_max_age_days,
    trigger_fresh_days: policy.drafter?.trigger_fresh_days,
    out_of_scope: policy.drafter?.out_of_scope,
  });
  log(`system prompt: ${buildSystem(null).length} chars before any angle is picked\n`);

  // Scores live as facts (score_total), and the CURRENT fact is the one nothing
  // else supersedes — `.is('supersedes', null)` would hand back the stale
  // original. Same walk advance_accounts.ts does.
  const scoreRows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', WS).eq('predicate', 'score_total').order('id').range(from, from + 999);
    const page = (data ?? []) as any[];
    scoreRows.push(...page);
    if (page.length < 1000) break;
  }
  const superseded = new Set(scoreRows.map((r) => r.supersedes).filter(Boolean));
  const ranked = scoreRows.filter((r) => !superseded.has(r.id))
    .map((r) => ({ entity_id: r.subject_entity, score: parseFloat(r.object_text ?? '') }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  log(`${ranked.length} accounts selected from ${scoreRows.length} score facts\n`);

  let drafted = 0, gated = 0, totalOut = 0;
  const bodies: Array<{ name: string; body: string }> = [];
  // Diagnostic, NOT a score. Sudden's product does one thing for one situation,
  // so most accounts landing on the same problem is the menu being honest, not
  // a defect. Read it for two things only: the picker refusing outright (every
  // row "none"), and a problem that never gets chosen by anything. What has to
  // vary between drafts is the anchor and the numbers, and the word-overlap
  // check below is what grades that.
  const angleCounts = new Map<string, number>();

  for (const row of ranked) {
    const { data: ent } = await sb.from('entities').select('id, name, attributes').eq('id', row.entity_id).maybeSingle();
    if (!ent) continue;
    const acct = { ...(ent as any), score: row.score };

    const { data: allFacts } = await sb
      .from('facts')
      .select('id, predicate, object_text, confidence, observed_at, signal_id, supersedes')
      .eq('workspace_id', WS)
      .eq('subject_entity', acct.id);
    const factRows = (allFacts ?? []) as any[];
    const pointed = new Set(factRows.map((f) => f.supersedes).filter(Boolean));
    const activeFacts = factRows.filter((f) =>
      !pointed.has(f.id) && !f.predicate.startsWith('score_') &&
      !['icp_fit', 'icp_fit_breakdown', 'contact_score', 'dropped_until', 'outreach_cooldown_until'].includes(f.predicate));
    if (!activeFacts.length) { log(`── ${acct.name}: no substantive facts, skipping\n`); continue; }

    // Same source-date recovery the live drafter does, and it has to STAY the
    // same or this harness grades prompts against behaviour that never ships.
    // Only a real published_at counts as the source date; everything else is
    // just when we filed it, and the fact lines say so.
    const sigIds = [...new Set(activeFacts.map((f) => f.signal_id).filter(Boolean))];
    const dateBySig = new Map<string, string>();
    if (sigIds.length) {
      const { data: srcSigs } = await sb.from('signals').select('id, observed_at, structured_tags').in('id', sigIds);
      for (const s of (srcSigs ?? []) as any[]) {
        const pub = s.structured_tags?.published_at;
        if (pub && Number.isFinite(Date.parse(pub))) dateBySig.set(s.id, pub);
      }
    }
    for (const f of activeFacts) {
      f.source_date = f.signal_id ? dateBySig.get(f.signal_id) : undefined;
      f.recorded_date = f.observed_at;
    }

    // works_at is a FACT (what create_contact writes and action_selector reads),
    // not an attribute. This used to query attributes.works_at, which nothing
    // sets, so every account graded as having zero contacts. Email is not
    // required on the linkedin channel — the templates need a name and a role.
    const { data: waFacts } = await sb.from('facts').select('subject_entity')
      .eq('workspace_id', WS).eq('predicate', 'works_at').eq('object_entity', acct.id).is('supersedes', null);
    const contactIds = [...new Set(((waFacts ?? []) as any[]).map((r) => r.subject_entity).filter(Boolean))].slice(0, 5);
    let contacts: Array<{ name: string; email: string; role: string }> = [];
    if (contactIds.length) {
      const { data: cEnts } = await sb.from('entities').select('id, name, attributes').in('id', contactIds);
      const { data: cFacts } = await sb.from('facts').select('subject_entity, predicate, object_text')
        .eq('workspace_id', WS).in('subject_entity', contactIds).in('predicate', ['role', 'email']).is('supersedes', null);
      const byId = new Map<string, { role?: string; email?: string }>();
      for (const f of (cFacts ?? []) as any[]) {
        const e = byId.get(f.subject_entity) ?? {};
        if (f.predicate === 'role') e.role = f.object_text; else e.email = f.object_text;
        byId.set(f.subject_entity, e);
      }
      contacts = ((cEnts ?? []) as any[]).map((c) => ({
        name: c.name,
        email: byId.get(c.id)?.email ?? c.attributes?.email ?? '',
        role: byId.get(c.id)?.role ?? c.attributes?.role ?? c.attributes?.title ?? '',
      }));
    }

    const { data: sig } = await sb.from('signals').select('*').eq('entity_id', acct.id).order('observed_at', { ascending: false }).limit(1).maybeSingle();

    let recommended: any[] = [];
    try {
      recommended = await scoreFacts(sb as any, { workspace_id: WS, entity_id: acct.id, facts: activeFacts as any, limit: 5 } as any);
    } catch { /* shortlist is a nice-to-have here */ }

    // Pick the argument before the prompt renders an exemplar, same order the
    // live drafter uses. A null angle means the picker declined or failed, and
    // the prompt falls back to the full menu.
    let decision: AngleDecision = { choice: null, reason: 'menu_too_small' };
    if (angleCache.has(acct.id)) {
      decision = angleCache.get(acct.id)!;
    } else if ((policy.drafter?.templates ?? []).length) {
      decision = await pickDraftAngle(sb as any, WS, {
        model: 'deepseek-v4-flash',
        account_name: acct.name,
        facts: activeFacts.map((f: any) => ({ predicate: f.predicate, object_text: f.object_text })),
        pain_points: policy.drafter?.pain_points ?? [],
        templates: policy.drafter?.templates ?? [],
      });
      angleCache.set(acct.id, decision);
      if (ANGLE_CACHE) writeFileSync(ANGLE_CACHE, JSON.stringify([...angleCache], null, 2));
    }
    const angle = decision.choice;
    const system = buildSystem(angle);

    const user = buildUserPrompt('claims_outbound_drafter', 'dry-run', 'dry-run grading pass',
      sig ?? {}, { id: acct.id, name: acct.name, attributes: acct.attributes }, activeFacts, [], contacts, recommended as any, true);

    // Same model, ceiling and response_format the live drafter uses. The ceiling
    // is RESOLVED, not typed in: it was hardcoded 3000 here while bf234ba moved
    // the live default to 8000, so a run that truncated in this harness proved
    // nothing about production and read as catastrophic draft loss.
    //
    // DRYRUN_THINKING lets one run be compared against another with the model's
    // pre-answer reasoning turned off. Unset matches live exactly, because the
    // live drafter never passes `thinking` either, so it inherits the provider
    // default. The llm.ts guidance to leave thinking on for anything that writes
    // was measured on cost and truncation, never on how the writing reads, so
    // whether it helps the voice is an open question this flag exists to answer.
    const thinking = process.env.DRYRUN_THINKING as 'enabled' | 'disabled' | undefined;
    const res = await chatCompleteForWorkspace(sb as any, WS, {
      model: 'deepseek-v4-pro',
      behavior: 'drafter',
      max_tokens: resolveMaxOutputTokens(policy, 'drafter'),
      response_format: { type: 'json_object' },
      ...(thinking ? { thinking } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    } as any);

    let parsed: any;
    try { parsed = JSON.parse(String(res.text ?? '').replace(/^```json\s*|\s*```$/g, '').trim()); }
    catch {
      // Print the length and the TAIL, not the head. A head-only slice looks
      // identical whether the model truncated or emitted trailing junk, and the
      // difference decides whether max_tokens needs raising.
      const raw = String(res.text ?? '');
      log(`── ${acct.name}: UNPARSEABLE  [${raw.length} chars, finish=${(res as any).finish_reason ?? '?'}]`);
      log(`   tail: ...${raw.slice(-160)}\n`);
      continue;
    }

    // Output tokens are the whole cost story on a reasoning model: the body is
    // ~120 of them and everything above that was spent thinking. Printed per
    // account so a prompt change that quietly triples the reasoning is visible
    // here rather than on the bill.
    const outTok = Number((res as any).output_tokens ?? 0);
    totalOut += outTok;
    log(`── ${acct.name}  (score=${Number(acct.score).toFixed(2)}, ${activeFacts.length} facts, ${contacts.length} contacts, ${outTok} out tok)`);
    log(`   angle: ${angle ? `${angle.problem.slice(0, 90)}  [withheld: ${angle.withheld_template_ids.join(', ') || 'none'}]  (${angle.why})` : `(none — ${decision.reason}, full menu rendered)`}`);
    if (angle) angleCounts.set(angle.problem, (angleCounts.get(angle.problem) ?? 0) + 1);
    if (parsed.action === 'request_gate') {
      gated++;
      log(`   GATE: ${parsed.body}\n`);
      continue;
    }
    drafted++;
    const body = String(parsed.body ?? '');
    bodies.push({ name: acct.name, body });
    log(`   ${body}`);
    log(`   [${body.length} chars]  reasoning: ${String(parsed.reasoning ?? '').slice(0, 220)}`);

    const flags: string[] = [];
    if (body.length > 440) flags.push(`over budget (${body.length})`);
    if (!/\?/.test(body)) flags.push('NO QUESTION');
    // A dash standing in for a comma is the loudest machine tell in a short
    // message, and it ran 4 of 12 before the craft rule went in.
    if (/[—–]/.test(body)) flags.push('em/en dash');
    const slot = body.match(/\[[^\]]{2,30}\]|\{\{[^}]{2,30}\}\}|<[a-z][a-z_ ]{1,29}>/i);
    if (slot) flags.push(`PLACEHOLDER ${slot[0]}`);
    // The think question has to be answerable from memory. One that opens "how
    // much" or "what share" is asking them to go and look, and the honest reply
    // is no reply. A fork ("or") or a yes/no opener is fine; this only catches
    // the shape STEP 3 already rules out.
    const questions = body.split(/(?<=[.?!])\s+/).filter((s) => s.trim().endsWith('?'));
    const answerable = questions.some((q) => /\bor\b/i.test(q) || /^(is|are|was|were|do|does|did|have|has|had|can|could|would|will|should|who)\b/i.test(q.trim()));
    if (questions.length && !answerable) flags.push(`question needs homework: "${questions[0]!.slice(0, 60)}"`);
    for (const re of BANNED_CTA) if (re.test(body)) flags.push(`banned CTA: ${re.source.slice(0, 30)}`);
    for (const re of BANNED_CLAIM) if (re.test(body)) flags.push(`banned claim: ${re.source.slice(0, 30)}`);
    if (FILLER.test(body)) flags.push(`filler: ${body.match(FILLER)![0]}`);
    if (!/template|\[[1-4]\]|t[1-4]_/i.test(String(parsed.reasoning ?? ''))) flags.push('reasoning names no template');
    log(flags.length ? `   FLAGS: ${flags.join(' | ')}\n` : `   clean\n`);
  }

  // Sameness check: do any two drafts share too much wording? This is the failure
  // the last batch had (ten messages, one message with the nouns swapped).
  // v4-pro output rate, off-peak, from DEFAULT_PRICING. Peak UTC hours bill 2x.
  const perDraft = drafted + gated ? totalOut / (drafted + gated) : 0;
  log(`\n=== ${drafted} drafted, ${gated} gated | ${totalOut} output tokens, ${perDraft.toFixed(0)} avg/account, $${((totalOut / 1e6) * 1.98).toFixed(3)} ===`);
  if (angleCounts.size) {
    log('problems chosen (diagnostic, not a score — see the note at angleCounts):');
    for (const [problem, n] of [...angleCounts].sort((a, b) => b[1] - a[1])) log(`  ${n}×  ${problem.slice(0, 100)}`);
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = new Set(bodies[i]!.body.toLowerCase().split(/\W+/).filter((t) => t.length > 4));
      const b = new Set(bodies[j]!.body.toLowerCase().split(/\W+/).filter((t) => t.length > 4));
      const overlap = [...a].filter((t) => b.has(t)).length / Math.max(1, Math.min(a.size, b.size));
      if (overlap > 0.45) log(`SAMENESS ${(overlap * 100).toFixed(0)}%: "${bodies[i]!.name}" vs "${bodies[j]!.name}"`);
    }
  }

  // The closing line, checked on its own. The whole-body measure above cannot
  // see a repeated closer: one shared sentence out of five moves total overlap
  // by a few points, well under the 45% bar. Measured on a real batch where
  // three of four drafts ended "Want me to put/run your numbers to it?" — bodies
  // scored 4-25% overlap and nothing flagged, while a prospect reading two of
  // them in a row sees the same form letter. The last sentence is also the ask,
  // so it is the line that decides whether the message reads as written for
  // this account.
  const closer = (b: string) => (b.trim().match(/[^.?!]+[.?!]?\s*$/)?.[0] ?? b).trim();
  const closerGroups = new Map<string, string[]>();
  for (const { name, body } of bodies) {
    const key = closer(body).toLowerCase().replace(/[^a-z ]/g, '');
    closerGroups.set(key, [...(closerGroups.get(key) ?? []), name]);
  }
  for (const [key, names] of closerGroups) {
    if (names.length > 1) log(`SAME CLOSER (${names.length}): "${key}" — ${names.join(', ')}`);
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = new Set(closer(bodies[i]!.body).toLowerCase().split(/\W+/).filter((t) => t.length > 4));
      const b = new Set(closer(bodies[j]!.body).toLowerCase().split(/\W+/).filter((t) => t.length > 4));
      if (!a.size || !b.size) continue;
      const overlap = [...a].filter((t) => b.has(t)).length / Math.max(1, Math.min(a.size, b.size));
      if (overlap > 0.6 && closer(bodies[i]!.body).toLowerCase() !== closer(bodies[j]!.body).toLowerCase()) {
        log(`NEAR-SAME CLOSER ${(overlap * 100).toFixed(0)}%: "${closer(bodies[i]!.body)}" vs "${closer(bodies[j]!.body)}"`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
