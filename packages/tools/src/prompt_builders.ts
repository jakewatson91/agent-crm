/**
 * Pure prompt builders. No DB, no LLM calls — just string composition.
 * Lives here (not in @agent-crm/primitives or in inngest) so both the runtime
 * agent and the Settings UI's preview endpoint can call them.
 *
 * Behavior identical to the functions that previously lived inside
 * inngest/functions/agent_logic.ts; moved here in Phase 5 so the customer can
 * see exactly what the LLM will be told before saving Settings.
 */

// A handful of keys read better with a human label than raw snake_case. The map
// is structural (it never touches the value); unknown keys fall back to a title-
// cased version of the key, so no vertical assumption is baked in.
const ATTRIBUTE_LABELS: Record<string, string> = {
  domain: 'Website',
};

/**
 * Render an entity's attributes as readable lines for a HUMAN-facing prompt
 * (the drafter). Drops internal/plumbing keys, timestamps (`*_at`), id fields
 * (`*_id`), and nested objects/arrays; relabels the few keys that read awkwardly
 * raw.
 *
 * Plumbing detection is structural, never a list of connector key names: any key
 * starting with `_` is treated as reserved/internal and dropped. Connectors that
 * stash working state or discovery hints on an entity prefix those keys with `_`
 * (e.g. `_discovered_via`, `_search_query`) so they never leak into an email and
 * this renderer stays portable — it knows no connector by name. Object/array
 * values (embeddings, the ATS hint blob) are dropped by the type check below
 * regardless of name.
 *
 * The enricher does NOT use this — it needs the raw keys to know what's already
 * extracted. Drafters get prose so the model stops echoing field names like
 * "domain" or "stack" into the email body.
 */
export function renderAttributesProse(attributes: unknown): string {
  if (!attributes || typeof attributes !== 'object') return '(none)';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (key.startsWith('_')) continue; // reserved/internal namespace
    if (key.endsWith('_at') || key.endsWith('_id')) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue; // nested structures aren't prose-worthy
    const label = ATTRIBUTE_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`${label}: ${value}`);
  }
  return lines.length ? lines.join('\n') : '(none)';
}

export interface DrafterDecisionOpts {
  /** Which channel to draft for. Defaults to 'email'. */
  outreach_channel?: 'email' | 'linkedin';
  subject_style?: 'one_word' | 'short_phrase' | 'question';
  paragraph_count?: number;
  pain_points?: string[];
  value_props?: string[];
  tone_keywords?: string[];
  ask_examples?: string[];
  forbidden_phrases?: string[];
  /**
   * Internal field/column names the email must never echo (e.g. "domain",
   * "tech_stack", "score"). These are THIS workspace's own field names, so they
   * live in config (policy.drafter.forbidden_field_terms), not in shared code —
   * a different vertical has different fields. Default empty = rely on the
   * generic "don't name internal fields" rule alone.
   */
  forbidden_field_terms?: string[];
  /**
   * Phase 0 market brief: a small list of current, dated market hooks rendered
   * as background context in the drafter prompt. Off or empty renders nothing.
   * Contents live in config (policy.drafter.market_brief), never in shared code.
   */
  market_brief?: { enabled?: boolean; items?: Array<{ text: string; url?: string; date?: string }> };
  /**
   * Workspace message templates (policy.drafter.templates). When non-empty on
   * the linkedin channel, the DM prompt below replaces the generic
   * connection-request formula. Contents are config, never code.
   */
  templates?: Array<{ id: string; label: string; audience: string; body: string; anatomy?: string; enabled?: boolean }>;
  /** Drafting rules rendered verbatim above the templates. */
  message_rules?: string[];
  /** Character target for the DM body. Default 400. */
  char_budget?: number;
}

export function buildDrafterDecision(opts: DrafterDecisionOpts): string {
  if ((opts.outreach_channel ?? 'email') === 'linkedin') {
    const templates = (opts.templates ?? []).filter((t) => t && t.enabled !== false && t.body?.trim() && t.audience?.trim());
    if (templates.length) {
      const rules = (opts.message_rules ?? []).filter((s) => s.trim().length > 0);
      const budget = opts.char_budget ?? 400;
      const tones = (opts.tone_keywords ?? []).filter((s) => s.trim().length > 0);
      const toneBlock = tones.length ? `\nTONE — ${tones.join(', ')}.\n` : '';
      const rulesBlock = rules.length
        ? rules.map((r) => `- ${r}`).join('\n')
        : `- Aim for under ${budget} characters.`;
      const templatesBlock = templates
        .map((t, i) => `[${i + 1}] ${t.label}\n    AUDIENCE: ${t.audience}\n    EXEMPLAR: "${t.body}"${t.anatomy ? `\n    ANATOMY: ${t.anatomy}` : ''}`)
        .join('\n\n');
      return `A new high-fit signal matched your saved filter rule. Write the LinkedIn DM for this account, following the workspace templates below.

RULES:
${rulesBlock}
- No greeting-and-sign-off padding. LinkedIn shows the sender's name.
- No subject line — set "subject" to null in your output.
- Do NOT mention "our system", "your profile", "according to our data", or any internal field name.
${toneBlock}
TEMPLATES — pick exactly ONE by matching the recipient (role, seniority, relationship to the buying decision) to each template's AUDIENCE line. Write a NEW message in the chosen template's structure and voice, anchored to THIS account's real trigger facts. Never reuse an exemplar's names, numbers, or trigger — the exemplar shows the shape, not the content.

${templatesBlock}

NO TRIGGER, NO DM — the trigger must be a real, recent, specific event or statement from the SIGNAL or active facts (a post, a talk, a launch, a hire, a stated number). A topic they cover or a generic description of their business is NOT a trigger. If the facts contain no genuine trigger, output {"action":"request_gate","body":"<one sentence: what trigger you'd need>","policy":"facts_insufficient_for_draft"} instead of forcing one.

LEAD-FACT SELECTION — same as always: prefer the RECOMMENDED FACTS shortlist when present. Anchor on evidence they have a problem you solve, not just any fact about them.

DON'T BEND THE SIGNAL — if the signal suggests they've already solved the problem (hired the team, built in-house), that's a disqualifier, not an angle.

REASONING — include a "reasoning" field: 1-2 sentences naming which template you chose, why it fits this recipient, and which facts you anchored to. Shown in the audit channel, not sent to the recipient.

Output strictly valid JSON:
{"action":"post_touch_draft","subject":null,"body":"<linkedin DM, aim under ${budget} chars>","cites":["<fact_id_uuid>",...],"reasoning":"<template chosen + facts anchored>","to_email":null}`;
    }
    const pains = (opts.pain_points ?? []).filter((s) => s.trim().length > 0);
    const values = (opts.value_props ?? []).filter((s) => s.trim().length > 0);
    const tones = (opts.tone_keywords ?? []).filter((s) => s.trim().length > 0);
    const painBlock = pains.length
      ? `The pains your product addresses (pick whichever fits THIS account):\n${pains.map((p) => `   - ${p}`).join('\n')}`
      : `Anchor on a pain this account plausibly has, grounded in their facts.`;
    const valueBlock = values.length
      ? `One concrete thing your product does (pick what connects to the pain):\n${values.map((v) => `   - ${v}`).join('\n')}`
      : `State one concrete behavior of your product — no vague claims.`;
    const toneBlock = tones.length ? `\nTONE — ${tones.join(', ')}.` : '';
    return `A new high-fit signal matched your saved filter rule. Write a LinkedIn connection request message.

RULES:
- Maximum 250 characters total. Count carefully — LinkedIn hard-cuts at 300.
- No greeting and no sign-off. LinkedIn prepends the sender's name automatically.
- One concrete hook from the signal or their facts. Never a generic opener.
- No pitch-speak. Write like a person, not a sales deck.
- End with a single low-commitment ask.
- No subject line — set "subject" to null in your output.
- Do NOT mention "our system", "your profile", "according to our data", or any internal field name.
${toneBlock}
${painBlock}

${valueBlock}

LEAD-FACT SELECTION — same as always: prefer the RECOMMENDED FACTS shortlist when present. Anchor on evidence they have a problem you solve, not just any fact about them.

DON'T BEND THE SIGNAL — if the signal suggests they've already solved the problem (hired the team, built in-house), that's a disqualifier, not an angle.

REASONING — include a "reasoning" field: 1-2 sentences on which facts you anchored to. Shown in the audit channel, not sent to the recipient.

Output strictly valid JSON:
{"action":"post_touch_draft","subject":null,"body":"<linkedin message, max 250 chars>","cites":["<fact_id_uuid>",...],"reasoning":"<which facts you anchored to>","to_email":null}`;
  }

  const style = opts.subject_style ?? 'one_word';
  const paraCount = opts.paragraph_count ?? 4;
  const pains = (opts.pain_points ?? []).filter((s) => s.trim().length > 0);
  const values = (opts.value_props ?? []).filter((s) => s.trim().length > 0);
  const tones = (opts.tone_keywords ?? []).filter((s) => s.trim().length > 0);
  const asks = (opts.ask_examples ?? ['Worth exploring?', 'Open to a quick chat?']).filter((s) => s.trim().length > 0);
  const forbidden = (opts.forbidden_phrases ?? []).filter((s) => s.trim().length > 0);
  const fieldTerms = (opts.forbidden_field_terms ?? []).filter((s) => s.trim().length > 0);
  // Market brief: background context only. Off or empty contributes nothing, so
  // the prompt stays byte-identical (and cache-identical) for workspaces that
  // haven't opted in. Capped at 5 so it can't balloon the cached system prefix.
  const briefItems = (opts.market_brief?.enabled ? (opts.market_brief.items ?? []) : [])
    .filter((i) => i && typeof i.text === 'string' && i.text.trim().length > 0)
    .slice(0, 5);
  const marketBriefBlock = briefItems.length
    ? `\n\nMARKET BRIEF (current background context, NOT facts about this account):\n${briefItems
        .map((i) => {
          const date = i.date ? ` (${i.date})` : '';
          const src = i.url ? ` [${i.url}]` : '';
          return `   - ${i.text.trim()}${date}${src}`;
        })
        .join('\n')}\nUSE: when you have no FRESH, specific fact for THIS touch (for example a follow-up where the strongest facts were already used in an earlier email, or a re-engagement after a long gap), you MAY open with ONE of these market shifts as a genuine reason to reach out again, then connect it to them. When you have a fresh, specific account fact to lead with, use that and skip the brief. At most one item, framed as something you've noticed in the market, never a stat dump or a market report.`
    : '';

  const subjectInstruction = style === 'one_word'
    ? 'SUBJECT — exactly ONE word. A concrete noun, ideally tied to the specific signal that triggered this. Never vague words like "Hello", "Question", "Quick", "Connect".'
    : style === 'question'
    ? 'SUBJECT — phrase as a short, specific question (under 60 chars). Avoid generic openers.'
    : 'SUBJECT — short phrase, 2-5 words. Concrete and signal-specific. Avoid vague openers like "Quick question" or "Following up".';

  const painBlock = pains.length
    ? `PROBLEM STATEMENT — 1-2 sentences naming the specific pain a prospect EXACTLY LIKE THIS ACCOUNT hits. Use the entity's facts/attributes to specialize. The pains your product speaks to (pick what fits, don't list all):\n${pains.map((p) => `   - ${p}`).join('\n')}\n   Tie the problem to a specific fact about THIS account.`
    : `PROBLEM STATEMENT — 1-2 sentences naming a specific pain a prospect like this account hits, anchored in one of the entity's active facts. Don't generalize.`;

  const valueBlock = values.length
    ? `ONE-LINER — exactly 1 sentence. State a CONCRETE FACT about how your product behaves. Pick one that connects to the problem statement:\n${values.map((v) => `   - ${v}`).join('\n')}`
    : `ONE-LINER — exactly 1 sentence. State a CONCRETE behavior or number about your product. Avoid generic phrases.`;

  const toneBlock = tones.length
    ? `\nTONE — write in this voice: ${tones.join(', ')}.\n`
    : '';

  const askBlock = `ASK — short. ${asks.map((a) => `"${a}"`).join(' or ')}. One sentence.`;

  const forbiddenBlock = forbidden.length
    ? `\nFORBIDDEN PHRASES (do NOT use any variant): ${forbidden.map((p) => `"${p}"`).join(', ')}. These are filler. Use a concrete behavior or a number instead.`
    : '';

  const fieldTermsClause = fieldTerms.length
    ? ` In particular, never name the internal fields this data is stored under (e.g. ${fieldTerms.map((t) => `"${t}"`).join(', ')}).`
    : '';

  return `A new high-fit signal matched your saved filter rule. Draft an outbound email to the account in the user message, following the formula below exactly.

EMAIL FORMULA — in this order, body broken into roughly ${paraCount} short paragraphs separated by blank lines:

1. ${subjectInstruction}

2. ACCUSATION AUDIT — one short sentence acknowledging this is a cold email and disarming. Write it fresh in your own words, tied to why you're reaching out to THIS company specifically — do not fall back on a generic stock opener. Don't apologize twice. Don't qualify it.

3. ${painBlock}

4. ${valueBlock}
${forbiddenBlock}

5. ${askBlock}

LEAD-FACT SELECTION — the user message may include a RECOMMENDED FACTS block (a deterministic shortlist scored on ICP match, recency, confidence, prior over-use, and outcome history). When present, prefer one of those facts as your anchor for the problem statement. Override only if the past_touch context demands it — e.g., the prior touch already led with the top recommended fact and you'd be repeating yourself, or the recommended fact conflicts with how the prior touch was framed.

GROUND THE CALLOUT IN EVIDENCE OF A PROBLEM WE SOLVE — the SIGNAL block contains the real source text. Anchor on the specific detail in it that shows this company actually has one of the pains in the PROBLEM STATEMENT above, and connect that evidence to what we sell (see ABOUT). The callout is NOT "any specific fact about them": a topic they cover, an article they wrote, an award, or a generic description of their business is NOT evidence they have our problem and NOT a reason to buy — do not anchor on it. The test for every opening line: would a reader think "yes, that's a real problem I have, and this product is about that"? If the signal shows no honest sign they have a problem we solve, do NOT force an angle — output the request_gate escape hatch naming the fact you'd need. Quote the relevant detail in their own words and let it drive both the problem statement and which value point you pick. Never invent numbers, customer names, case studies, or results ("3x more demos", "teams like yours saw…") — a specific true behavior beats a fake metric.

DON'T BEND THE SIGNAL TO FIT THE PITCH — most signals cut both ways. The same hiring post, funding round, partnership, or launch can mean the prospect HAS the problem we solve, or that they've already solved it (they hired the team, raised the money, built the function in-house). Read it the honest way, not the convenient way, and assume the prospect knows their own situation better than you do. Anchor only on evidence that genuinely shows the problem still exists for THEM. If the strongest signal actually points the other way — it suggests they've already addressed or outgrown the problem — that LOWERS the fit, it does not raise it: drop that angle, pose it as a question rather than a verdict, or refuse via request_gate. Never tell the prospect their own strategy is a mistake, and never assert a problem the facts don't clearly support, just to force a connection to what we sell.
${toneBlock}${marketBriefBlock}
RECIPIENT — if CONTACTS are present in the user message, pick the best fit for the angle. Echo the chosen email in the output's "to_email" field. If no CONTACTS, set "to_email" to null.

NEVER MENTION INTERNAL DATA OR FIELD NAMES — write as a person who researched this company on the open web, not as software reading a record. Do not name any internal field or column the data is stored under, and do not use data-source language ("our system shows", "your profile", "according to our data", "we have you down as", "based on the signal").${fieldTermsClause} Say the real-world thing instead: name the company's actual site, product, or the specific tools they mentioned — not the field that holds them. If you can't say it the way a human researcher would, leave it out.

Voice and hard rules come from the workspace constitution above. Constitution wins over this formula on tone — if the constitution says "no em dashes" or "no jargon," follow that strictly even if the formula's examples use them.

The decision to draft has already been made upstream — a deterministic action selector ran the scores against thresholds before invoking you. You are here because the entity cleared all the bars. Your job is to WRITE the email, not to second-guess.

If the active facts genuinely don't give you enough to write something concrete (you'd be reaching for generic phrases), output {"action":"request_gate","body":"<one sentence: what specific fact you'd need>","policy":"facts_insufficient_for_draft"} — but that's a rare escape hatch, not the default path.

REASONING — every post_touch_draft output MUST include a "reasoning" field: 1-2 sentences explaining which 2-3 facts you anchored to. This becomes a separate "decision" post in the channel so the human auditor can see why each draft happened.

Output strictly valid JSON, no preamble:
{"action":"post_touch_draft","subject":"<see subject rule>","body":"<email body, ~${paraCount} short paragraphs separated by blank lines>","cites":["<fact_id_uuid>",...],"reasoning":"<which facts you anchored to, 1-2 sentences>","to_email":"<picked contact email or null>"}`;
}
