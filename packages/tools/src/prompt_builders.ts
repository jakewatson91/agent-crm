/**
 * Pure prompt builders. No DB, no LLM calls — just string composition.
 * Lives here (not in @agent-crm/primitives or in inngest) so both the runtime
 * agent and the Settings UI's preview endpoint can call them.
 *
 * Behavior identical to the functions that previously lived inside
 * inngest/functions/agent_logic.ts; moved here in Phase 5 so the customer can
 * see exactly what the LLM will be told before saving Settings.
 */

export interface DrafterDecisionOpts {
  subject_style?: 'one_word' | 'short_phrase' | 'question';
  paragraph_count?: number;
  pain_points?: string[];
  value_props?: string[];
  tone_keywords?: string[];
  ask_examples?: string[];
  forbidden_phrases?: string[];
}

export function buildDrafterDecision(opts: DrafterDecisionOpts): string {
  const style = opts.subject_style ?? 'one_word';
  const paraCount = opts.paragraph_count ?? 4;
  const pains = (opts.pain_points ?? []).filter((s) => s.trim().length > 0);
  const values = (opts.value_props ?? []).filter((s) => s.trim().length > 0);
  const tones = (opts.tone_keywords ?? []).filter((s) => s.trim().length > 0);
  const asks = (opts.ask_examples ?? ['Worth exploring?', 'Open to a quick chat?']).filter((s) => s.trim().length > 0);
  const forbidden = (opts.forbidden_phrases ?? []).filter((s) => s.trim().length > 0);

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

  return `A new high-fit signal matched your saved filter rule. Draft an outbound email to the account in the user message, following the formula below exactly.

EMAIL FORMULA — in this order, body broken into roughly ${paraCount} short paragraphs separated by blank lines:

1. ${subjectInstruction}

2. ACCUSATION AUDIT — one short sentence acknowledging this is a cold email and disarming. Examples: "Hope you don't mind the cold connect." / "Quick cold note, I'll keep it short." / "You might hate me for the cold email." Don't apologize twice. Don't qualify it.

3. ${painBlock}

4. ${valueBlock}
${forbiddenBlock}

5. ${askBlock}
${toneBlock}
RECIPIENT — if CONTACTS are present in the user message, pick the best fit for the angle. Echo the chosen email in the output's "to_email" field. If no CONTACTS, set "to_email" to null.

Voice and hard rules come from the workspace constitution above. Constitution wins over this formula on tone — if the constitution says "no em dashes" or "no jargon," follow that strictly even if the formula's examples use them.

The decision to draft has already been made upstream — a deterministic action selector ran the scores against thresholds before invoking you. You are here because the entity cleared all the bars. Your job is to WRITE the email, not to second-guess.

If the active facts genuinely don't give you enough to write something concrete (you'd be reaching for generic phrases), output {"action":"request_gate","body":"<one sentence: what specific fact you'd need>","policy":"facts_insufficient_for_draft"} — but that's a rare escape hatch, not the default path.

REASONING — every post_touch_draft output MUST include a "reasoning" field: 1-2 sentences explaining which 2-3 facts you anchored to. This becomes a separate "decision" post in the channel so the human auditor can see why each draft happened.

Output strictly valid JSON, no preamble:
{"action":"post_touch_draft","subject":"<see subject rule>","body":"<email body, ~${paraCount} short paragraphs separated by blank lines>","cites":["<fact_id_uuid>",...],"reasoning":"<which facts you anchored to, 1-2 sentences>","to_email":"<picked contact email or null>"}`;
}
