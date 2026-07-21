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
import { appendFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace, scoreFacts } from '@agent-crm/tools';
import { buildSystemPrompt, buildUserPrompt } from '../inngest/functions/agent_logic.js';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const OUT = process.env.DRYRUN_OUT ?? '/tmp/sudden_dryrun.txt';

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

  const system = buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
    outreach_channel: policy.drafter?.outreach_channel,
    pain_points: policy.drafter?.pain_points,
    value_props: policy.drafter?.value_props,
    tone_keywords: policy.drafter?.tone_keywords,
    forbidden_phrases: policy.outreach?.banned_phrases ?? [],
    forbidden_field_terms: policy.drafter?.forbidden_field_terms ?? [],
    templates: policy.drafter?.templates,
    message_rules: policy.drafter?.message_rules,
    char_budget: policy.drafter?.char_budget,
  });
  log(`system prompt: ${system.length} chars\n`);

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

  let drafted = 0, gated = 0;
  const bodies: Array<{ name: string; body: string }> = [];

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

    const { data: contactRows } = await sb
      .from('entities').select('name, attributes').eq('workspace_id', WS)
      .contains('attributes', { works_at: acct.id }).limit(5);
    const contacts = ((contactRows ?? []) as any[])
      .map((c) => ({ name: c.name, email: c.attributes?.email ?? '', role: c.attributes?.role ?? c.attributes?.title ?? '' }))
      .filter((c) => c.email);

    const { data: sig } = await sb.from('signals').select('*').eq('entity_id', acct.id).order('observed_at', { ascending: false }).limit(1).maybeSingle();

    let recommended: any[] = [];
    try {
      recommended = await scoreFacts(sb as any, { workspace_id: WS, entity_id: acct.id, facts: activeFacts as any, limit: 5 } as any);
    } catch { /* shortlist is a nice-to-have here */ }

    const user = buildUserPrompt('claims_outbound_drafter', 'dry-run', 'dry-run grading pass',
      sig ?? {}, { id: acct.id, name: acct.name, attributes: acct.attributes }, activeFacts, [], contacts, recommended as any, true);

    // Same model, max_tokens and response_format the live drafter uses
    // (agent_logic.ts DRAFTER_MODEL). Not a choice made here.
    const res = await chatCompleteForWorkspace(sb as any, WS, {
      model: 'deepseek-v4-pro',
      behavior: 'drafter',
      max_tokens: 1500,
      response_format: { type: 'json_object' },
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

    log(`── ${acct.name}  (score=${Number(acct.score).toFixed(2)}, ${activeFacts.length} facts, ${contacts.length} contacts)`);
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
    for (const re of BANNED_CTA) if (re.test(body)) flags.push(`banned CTA: ${re.source.slice(0, 30)}`);
    for (const re of BANNED_CLAIM) if (re.test(body)) flags.push(`banned claim: ${re.source.slice(0, 30)}`);
    if (FILLER.test(body)) flags.push(`filler: ${body.match(FILLER)![0]}`);
    if (!/template|\[[1-4]\]|t[1-4]_/i.test(String(parsed.reasoning ?? ''))) flags.push('reasoning names no template');
    log(flags.length ? `   FLAGS: ${flags.join(' | ')}\n` : `   clean\n`);
  }

  // Sameness check: do any two drafts share too much wording? This is the failure
  // the last batch had (ten messages, one message with the nouns swapped).
  log(`\n=== ${drafted} drafted, ${gated} gated ===`);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = new Set(bodies[i]!.body.toLowerCase().split(/\W+/).filter((t) => t.length > 4));
      const b = new Set(bodies[j]!.body.toLowerCase().split(/\W+/).filter((t) => t.length > 4));
      const overlap = [...a].filter((t) => b.has(t)).length / Math.max(1, Math.min(a.size, b.size));
      if (overlap > 0.45) log(`SAMENESS ${(overlap * 100).toFixed(0)}%: "${bodies[i]!.name}" vs "${bodies[j]!.name}"`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
