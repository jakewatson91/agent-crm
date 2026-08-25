/**
 * Vertical-neutral LLM derivation: turn a plain-English `about` into the
 * structured workspace fields the agent loop expects.
 *
 * Used by:
 *   - /api/workspaces/create     (initial wizard)
 *   - /api/workspaces/regenerate (Settings "Regenerate from About" button)
 *
 * Everything derived here is also editable on the Settings page. That is the
 * rule for adding a field: if a customer cannot see it and change it after the
 * wizard has guessed it, do not derive it. `out_of_scope` is the reason the rule
 * exists — it is a hard veto that drops an account to icp_total 0, so a wrong
 * guess silently deletes prospects, and a silent deletion nobody can find in the
 * UI is worse than no guess at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { chatCompleteForWorkspace } from '@agent-crm/tools';

export interface DerivedDefaults {
  icp: Record<string, unknown>;
  persona: Record<string, unknown>;
  constitution: string;
  knowledge_base: string;
  example_facts: Array<{ predicate: string; object_text: string }>;
  pain_points: string[];
  value_props: string[];
  tone_keywords: string[];
  out_of_scope: string[];
  trigger_fresh_days: number;
  trigger_max_age_days: number;
  outreach_language: string;
}

const SYSTEM_PROMPT = `You configure an agent-native CRM for a new customer. Read their plain-English description of what the agent should help with, then output JSON with these fields:

- "icp": object describing the kinds of accounts/things the agent should care about. Keys are open — pick what makes sense for this customer (industry, stage, location, size, signal_type, anything). Don't force B2B SaaS terms onto a non-SaaS use case.
- "persona": object with one or two keys describing how the agent represents the customer. Open keys; "pitch" or "voice" are common.
- "constitution": short free-form prose. Voice, do-nots, hard rules. Plain English, no jargon. 5-12 short lines.
- "knowledge_base": optional pain-to-angle mapping in the format described below; empty string if not applicable.
- "example_facts": array of 5-8 {predicate, object_text} pairs the enricher should look for when reading signals about an entity. Choose predicates appropriate for the vertical (real-estate = list_price, days_on_market; B2B sales = hiring_for, raised_round). Don't reuse B2B examples on non-B2B workspaces.
- "out_of_scope": array of 0 to 4 plain sentences, each naming a kind of account this customer CANNOT sell to and each checkable against facts about a company. "They resell what we sell instead of buying it." "They operate only in countries we don't ship to." THIS IS A HARD VETO: a matching account is dropped from the book entirely, so write a condition ONLY where the description states an actual limit. An empty array is the normal and correct answer for most customers. Never infer a limit from the industry, and never write a condition that just restates the ICP in the negative.
- "pain_points": array of 3-5 short strings describing the specific pains this customer's product addresses. The drafter uses these in cold outreach. Concrete, observable, prospect-recognizable language. Not "they want to grow" — "their sales team is one person and the founder is doing outbound at night."
- "value_props": array of 3-5 short strings — concrete behaviors the drafter can cite in the one-liner. Use numbers ONLY if the customer's description states them. NEVER invent stats, client counts, deal counts, or track-record claims ("closed 50+ deals", "trusted by 200 teams") that aren't in the description — the drafter will repeat them as fact in real emails. If the description has no numbers, write number-free value props.
- "tone_keywords": array of 3-6 short words describing the email tone. e.g. ["casual", "concrete", "no-jargon"].
- "trigger_fresh_days": integer. How many days old a piece of news can be in this customer's market and still be worth opening a message with. Consumer and funding-driven markets move in days; infrastructure, procurement and regulated markets move in months. Use 14 when the description gives you nothing to go on.
- "trigger_max_age_days": integer, larger than trigger_fresh_days. Past this an event is dead and can't even be background. Use 90 when the description gives you nothing to go on.
- "outreach_language": the language outgoing messages should be written in, as its English name ("English", "German", "Japanese"). Take it from the market the customer says they sell into, NOT from the language this description happens to be written in. "English" when unclear.

KNOWLEDGE_BASE FORMAT (only if it fits the use case):
- TRIGGERS: <phrases the target audience might say>
  ANGLE: <which of their angles connects, 1 sentence>

Output strictly valid JSON, with the keys in THIS order — "out_of_scope" is decided before "pain_points" on purpose, so the pains you write are ones the accounts you can actually sell to would recognise: {"icp":{...},"persona":{...},"constitution":"...","knowledge_base":"...","example_facts":[{"predicate":"...","object_text":"..."}],"out_of_scope":[],"pain_points":["..."],"value_props":["..."],"tone_keywords":["..."],"trigger_fresh_days":14,"trigger_max_age_days":90,"outreach_language":"English"}`;

export const EMPTY: DerivedDefaults = {
  icp: {}, persona: {}, constitution: '', knowledge_base: '', example_facts: [],
  pain_points: [], value_props: [], tone_keywords: [],
  out_of_scope: [], trigger_fresh_days: 14, trigger_max_age_days: 90, outreach_language: 'English',
};

const toStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()) : [];

/** Whole days inside [lo, hi], or `def` when the model returned something else. */
function days(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Coerce one raw model response into the shape the policy expects. Exported so
 * `scripts/check_derive_defaults.ts` can pin the bounds without an LLM call —
 * every field here is a workspace default a customer inherits silently, so the
 * clamping is the part worth testing.
 */
export function sanitizeDerived(raw: unknown): DerivedDefaults {
  const j = (raw ?? {}) as Record<string, unknown>;
  const fresh = days(j.trigger_fresh_days, 14, 3, 60);
  // A max below fresh would make mode A unreachable: no event can be both fresh
  // enough to lead with and inside a shorter dead-weight window.
  const maxAge = Math.max(fresh, days(j.trigger_max_age_days, 90, 14, 365));
  const language = typeof j.outreach_language === 'string' && j.outreach_language.trim() ? j.outreach_language.trim() : 'English';
  const facts = Array.isArray(j.example_facts)
    ? (j.example_facts as Array<{ predicate?: unknown; object_text?: unknown }>)
        .filter((f) => typeof f?.predicate === 'string' && typeof f?.object_text === 'string')
        .map((f) => ({ predicate: f.predicate as string, object_text: f.object_text as string }))
    : [];
  return {
    icp: (j.icp ?? {}) as Record<string, unknown>,
    persona: (j.persona ?? {}) as Record<string, unknown>,
    constitution: typeof j.constitution === 'string' ? j.constitution : '',
    knowledge_base: typeof j.knowledge_base === 'string' ? j.knowledge_base : '',
    example_facts: facts,
    pain_points: toStrArr(j.pain_points),
    value_props: toStrArr(j.value_props),
    tone_keywords: toStrArr(j.tone_keywords),
    // Capped at 4 and deduped. Each one deletes accounts, so a model that gets
    // enthusiastic here can empty a book; four is more than any real customer
    // has given us and still leaves the list readable in Settings.
    out_of_scope: [...new Set(toStrArr(j.out_of_scope))].slice(0, 4),
    trigger_fresh_days: fresh,
    trigger_max_age_days: maxAge,
    outreach_language: language,
  };
}

/**
 * `ws` is required and nullable rather than optional, because the two callers
 * genuinely differ and the difference should not be forgettable.
 *
 * The wizard runs this before the workspace row exists, so it has nothing to
 * pass and says so with `null`. Settings runs it against a workspace that has
 * been around long enough to have a model and an API key configured, and
 * passing those is the whole point — otherwise a customer who has pointed the
 * setup behavior at their own model watches Regenerate ignore it and bill the
 * deployment's key instead.
 *
 * An optional parameter would have let the Settings caller stay wrong by
 * accident, which is how the research planner spent months reading no config at
 * all. Making it explicit means a third caller has to decide.
 */
export async function deriveDefaults(
  ws: { supabase: SupabaseClient; workspace_id: string } | null,
  about: string,
): Promise<DerivedDefaults> {
  const args = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: `Customer description:\n${about}` },
    ],
    response_format: { type: 'json_object' as const },
    max_tokens: 1400,
  };
  try {
    const r = ws
      ? await chatCompleteForWorkspace(ws.supabase, ws.workspace_id, { ...args, behavior: 'wizard' })
      : await chatComplete(args);
    return sanitizeDerived(JSON.parse(r.text));
  } catch {
    return EMPTY;
  }
}
