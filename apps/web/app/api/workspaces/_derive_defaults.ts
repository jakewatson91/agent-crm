/**
 * Vertical-neutral LLM derivation: turn a plain-English `about` into the
 * structured workspace fields the agent loop expects.
 *
 * Used by:
 *   - /api/workspaces/create     (initial wizard)
 *   - /api/workspaces/regenerate (Settings "Regenerate from About" button)
 */
import { chatComplete } from '@agent-crm/primitives';

export interface DerivedDefaults {
  icp: Record<string, unknown>;
  persona: Record<string, unknown>;
  constitution: string;
  knowledge_base: string;
  example_facts: Array<{ predicate: string; object_text: string }>;
  pain_points: string[];
  value_props: string[];
  tone_keywords: string[];
}

const SYSTEM_PROMPT = `You configure an agent-native CRM for a new customer. Read their plain-English description of what the agent should help with, then output JSON with these fields:

- "icp": object describing the kinds of accounts/things the agent should care about. Keys are open — pick what makes sense for this customer (industry, stage, location, size, signal_type, anything). Don't force B2B SaaS terms onto a non-SaaS use case.
- "persona": object with one or two keys describing how the agent represents the customer. Open keys; "pitch" or "voice" are common.
- "constitution": short free-form prose. Voice, do-nots, hard rules. Plain English, no jargon. 5-12 short lines.
- "knowledge_base": optional pain-to-angle mapping in the format described below; empty string if not applicable.
- "example_facts": array of 5-8 {predicate, object_text} pairs the enricher should look for when reading signals about an entity. Choose predicates appropriate for the vertical (real-estate = list_price, days_on_market; B2B sales = hiring_for, raised_round). Don't reuse B2B examples on non-B2B workspaces.
- "pain_points": array of 3-5 short strings describing the specific pains this customer's product addresses. The drafter uses these in cold outreach. Concrete, observable, prospect-recognizable language. Not "they want to grow" — "their sales team is one person and the founder is doing outbound at night."
- "value_props": array of 3-5 short strings — concrete behaviors the drafter can cite in the one-liner. Use numbers ONLY if the customer's description states them. NEVER invent stats, client counts, deal counts, or track-record claims ("closed 50+ deals", "trusted by 200 teams") that aren't in the description — the drafter will repeat them as fact in real emails. If the description has no numbers, write number-free value props.
- "tone_keywords": array of 3-6 short words describing the email tone. e.g. ["casual", "concrete", "no-jargon"].

KNOWLEDGE_BASE FORMAT (only if it fits the use case):
- TRIGGERS: <phrases the target audience might say>
  ANGLE: <which of their angles connects, 1 sentence>

Output strictly valid JSON: {"icp":{...},"persona":{...},"constitution":"...","knowledge_base":"...","example_facts":[{"predicate":"...","object_text":"..."}],"pain_points":["...","..."],"value_props":["...","..."],"tone_keywords":["...","..."]}`;

const EMPTY: DerivedDefaults = { icp: {}, persona: {}, constitution: '', knowledge_base: '', example_facts: [], pain_points: [], value_props: [], tone_keywords: [] };

export async function deriveDefaults(about: string): Promise<DerivedDefaults> {
  try {
    const r = await chatComplete({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Customer description:\n${about}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });
    const j = JSON.parse(r.text);
    const examples = Array.isArray(j.example_facts)
      ? (j.example_facts as Array<{ predicate?: unknown; object_text?: unknown }>)
          .filter((f) => typeof f?.predicate === 'string' && typeof f?.object_text === 'string')
          .map((f) => ({ predicate: f.predicate as string, object_text: f.object_text as string }))
      : [];
    const toStrArr = (v: unknown): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
    return {
      icp: (j.icp ?? {}) as Record<string, unknown>,
      persona: (j.persona ?? {}) as Record<string, unknown>,
      constitution: typeof j.constitution === 'string' ? j.constitution : '',
      knowledge_base: typeof j.knowledge_base === 'string' ? j.knowledge_base : '',
      example_facts: examples,
      pain_points: toStrArr(j.pain_points),
      value_props: toStrArr(j.value_props),
      tone_keywords: toStrArr(j.tone_keywords),
    };
  } catch {
    return EMPTY;
  }
}
