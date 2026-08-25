/**
 * Read and change workspace config from an agent, in the same shape a person
 * would use.
 *
 * WHY THIS EXISTS. The most consequential sentences in this system — what a
 * message argues, and what research goes looking for — were written by a model
 * at setup and then reachable by nobody. The research questions have no screen
 * at all: nothing in the app reads or writes them. So the question asking what
 * an executive had said about delivery costs sat too narrow for months, with no
 * search behind it, and the only way to widen it was a script written by hand.
 *
 * A screen is one answer. This is the other, and it is the one that fits how the
 * customer actually works: say what you want changed, see exactly what changed,
 * undo it if it was wrong.
 *
 * WHAT THIS IS NOT. It does not take prose and guess. The caller is already a
 * model holding the conversation; turning "widen that question" into a concrete
 * value is its job, and doing it again in here would mean a second prompt, a
 * second model bill, and two places to debug the same sentence. This takes the
 * finished value, checks it, writes it, and reports what moved.
 *
 * SAFETY. Every write goes through set_workspace_policy, which is where the
 * rules that protect a customer from an agent live: rewriting an argument drops
 * its confirmation so it writes three messages and waits, and rewording a
 * research question restarts its record. Those run here for the same reason
 * they run for the settings page — because they are enforced under the write,
 * not at the caller.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPolicy, type WorkspacePolicy } from './policy.ts';

/**
 * The parts of config an agent may change, and what each one decides.
 *
 * An allowlist rather than a free path, because policy also holds API keys,
 * embedding caches, pipeline state and the planner's own bookkeeping. None of
 * that is a customer decision and a wrong write to any of it is silent.
 *
 * `read_only` marks the things worth SEEING but not worth hand-editing: the
 * searches are rewritten by the planner every couple of weeks, so a hand edit
 * would be quietly reverted — pinning is the supported way to keep one.
 */
export const CONFIG_SECTIONS = {
  'drafter.arguments': {
    what: 'The arguments this workspace makes. Each is: the event at a company that makes it worth writing (when), what must already be true of them for the claim to be honest (only_if), what it costs them (so), and what you are asking for (ask). Editing the wording of one drops its confirmation, so it writes three messages and waits for a human to read them.',
  },
  'drafter.pain_points': { what: 'Problems this product solves, in the prospect\'s words. One per line.' },
  'drafter.value_props': { what: 'Concrete things the product does that may be stated in a message.' },
  'drafter.out_of_scope': { what: 'Plain sentences describing companies that cannot be served. A match forces the fit score to zero and refuses the message.' },
  'drafter.trigger_fresh_days': { what: 'How recent an event must be to lead a message as news. Default 14.' },
  'drafter.trigger_max_age_days': { what: 'How old an event may be before it cannot be built on at all. Default 90.' },
  'research.brief': {
    what: 'The questions research goes looking for. Every search exists to answer one of these, the page filter keeps a page only if it answers one, and the extractor is told to pull nothing else. Rewording a question restarts its track record so the new wording is not judged on the old one\'s numbers.',
  },
  'research.strategy': {
    what: 'The searches themselves, one per question. The planner rewrites these on a timer, so a hand edit does not last — set `pinned: true` on one to keep it exactly as written across regenerations. That is the only way to keep a search for a question the planner has decided it cannot cover.',
  },
  'research.searches_per_run': { what: 'How many searches each research tick may spend. The main cost lever.' },
  'research.max_age_days': { what: 'How old a page may be and still be stored.' },
  'routing.draft_icp_total': { what: 'Fit score an account needs before a message is written. Higher is pickier.' },
  'routing.drop_icp_total': { what: 'Fit score below which an account is set aside for 90 days.' },
  'llm.models': { what: 'Which model runs each behavior. Keys are behavior names, values are model ids. `default` covers anything not named.' },
} as const;

export type ConfigSection = keyof typeof CONFIG_SECTIONS;

export function isConfigSection(s: string): s is ConfigSection {
  return Object.prototype.hasOwnProperty.call(CONFIG_SECTIONS, s);
}

function readPath(policy: WorkspacePolicy, section: string): unknown {
  return section.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    policy,
  );
}

function writePath(policy: Record<string, unknown>, section: string, value: unknown): void {
  const parts = section.split('.');
  const last = parts.pop()!;
  let cur = policy;
  for (const k of parts) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[last] = value;
}

export interface ConfigRead {
  section: ConfigSection;
  what: string;
  value: unknown;
}

/**
 * Read one section, or every section when none is named.
 *
 * Reading everything is the answer to "what is my agent actually set up to do",
 * which nobody could ask before. It stays small because the allowlist is small;
 * the parts of policy that are big (caches, embeddings, planner bookkeeping) are
 * not on it.
 */
export async function readWorkspaceConfig(
  supabase: SupabaseClient,
  workspace_id: string,
  section?: string,
): Promise<ConfigRead[]> {
  const policy = await getPolicy(supabase, workspace_id);
  const sections = section ? [section] : Object.keys(CONFIG_SECTIONS);
  const out: ConfigRead[] = [];
  for (const s of sections) {
    if (!isConfigSection(s)) continue;
    out.push({ section: s, what: CONFIG_SECTIONS[s].what, value: readPath(policy, s) ?? null });
  }
  return out;
}

export interface ConfigChange {
  section: ConfigSection;
  before: unknown;
  after: unknown;
  /** The whole policy as it was, so the event row alone is enough to undo. */
  prior_state: Record<string, unknown>;
  next_policy: Record<string, unknown>;
}

/**
 * Stage a change without writing it. The caller applies it via
 * set_workspace_policy so the argument and question rules run under the write.
 *
 * Returns before and after rather than a rendered diff, because the thing that
 * has to be shown to a human varies (a list of arguments reads as prose, a
 * threshold reads as a number) and that is a presentation decision for whatever
 * surface is asking.
 */
export async function stageConfigChange(
  supabase: SupabaseClient,
  workspace_id: string,
  section: string,
  value: unknown,
): Promise<ConfigChange | { error: string }> {
  if (!isConfigSection(section)) {
    return { error: `"${section}" is not editable. One of: ${Object.keys(CONFIG_SECTIONS).join(', ')}` };
  }
  const policy = await getPolicy(supabase, workspace_id);
  const before = readPath(policy, section) ?? null;
  const next = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
  writePath(next, section, value);
  return {
    section,
    before,
    after: value,
    prior_state: JSON.parse(JSON.stringify(policy)) as Record<string, unknown>,
    next_policy: next,
  };
}
