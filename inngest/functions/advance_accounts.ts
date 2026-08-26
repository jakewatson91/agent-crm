/**
 * Account-driven advance pass — the daily spine.
 *
 * The rest of the pipeline is SIGNAL-triggered: an agent only runs on an account
 * when a fresh signal for it lands in the window. So an account that scored well
 * once and then went quiet never advances — it never requests contacts, never
 * drafts. That is the "we score 94 good accounts and produce nothing" gap.
 *
 * This pass is ACCOUNT-triggered. Every run it walks accounts in the order set by
 * compareWalkOrder — the ones that clear the draft bars first, then the ones with
 * a live reason to write, then by fit — and for each one:
 *   1. If it's a strong fit with no reachable contact, pull decision-makers now
 *      (synchronous — no Inngest), through the workspace's configured provider,
 *      and score them.
 *   2. Run the drafter over the account (via runAgent with a fact trigger). That
 *      reuses the exact same selectAction + drafter + gate path the signal loop
 *      uses, so behavior can't drift. The drafter self-gates on fact quality and
 *      only creates a draft (a gate = one approval) when there's a real hook and
 *      a real recipient.
 *
 * Fail-loud: when a provider or the LLM returns a credit/auth error (DeepSeek 402
 * "Insufficient Balance", Hunter/Explorium 401/402/429), the pass STOPS, writes a
 * plain-language paused status onto the workspace the UI shows, and returns. It
 * does not keep burning attempts against an empty balance. Clearing the pause
 * (the "Continue" action) lets the next run resume where it left off.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pullContactsForAccount, loadBestContactScore, getPolicy, buildThresholds,
  latestMarkerByEntity, ACTIVITY_MARKERS,
  getPipelineStatus, setPipelineStatus, DEFAULT_ANCHOR_FRESH_DAYS, type PipelineStatus,
} from '@agent-crm/tools';
import { createServerClient } from '@agent-crm/db';
import { runAgent } from './agent_logic.ts';
import { inngest } from '../client.ts';

export interface AdvanceOptions {
  workspace_id: string;
  /** Max contact pulls this run (bounds provider spend). Default 8. */
  contactCap?: number;
  /** Max drafter LLM runs this run (bounds LLM spend). Default 12. */
  draftCap?: number;
  /** Safety cap on how many accounts we scan. Default 400. */
  maxAccounts?: number;
  /** Optional per-step progress line (the loop/script passes console.log). */
  onEvent?: (line: string) => void;
}

export interface AdvanceResult {
  scanned: number;
  contacts_pulled: number;   // accounts we attempted a pull on
  contacts_created: number;  // new contact entities created
  drafts_created: number;    // new draft gates (approvals) produced
  decisions: Record<string, number>;
  /** Up to DECISION_EXAMPLES account names per decision, so a report can name
   *  the 4 accounts behind "skip:facts_insufficient" instead of just counting. */
  examples: Record<string, string[]>;
  paused?: PipelineStatus;   // set when we halted on a credit/auth error
}

/** Names kept per decision. Bounds the event payload; events are read hot. */
const DECISION_EXAMPLES = 6;

/**
 * A provider/LLM error we should HALT on (out of money / bad key / rate limited),
 * vs. a benign per-account skip (no domain, matched-but-found-nobody, one bad
 * prospect). Halting errors mean the next account will fail the same way, so we
 * stop and wait for the human instead of draining the run.
 */
export function isHaltingError(msg: string | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes('insufficient balance') ||
    m.includes('insufficient_quota') ||
    m.includes('quota') ||
    m.includes('credit') ||
    m.includes('payment required') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('unauthorized') ||
    m.includes('invalid api key') ||
    m.includes('invalid_api_key') ||
    /\b(401|402|429)\b/.test(m)
  );
}

/**
 * A halting error that will STILL be there on the next tick: out of money, bad
 * key, revoked access. These are worth latching a pause for, because the operator
 * has to go do something before anything can work again.
 *
 * Rate limits are deliberately excluded. A 429 means "you asked too fast", which
 * clears itself in seconds. Latching a pipeline pause on one turned a burst limit
 * into an indefinite outage: the runner returns early on a standing pause without
 * ever calling the provider again, so no error is recorded, nothing re-tests it,
 * and research stays dark until a human clicks Continue. That is exactly how
 * Sudden sat paused for three days against a completely healthy Exa key.
 *
 * Callers should still STOP the current run on any isHaltingError (backing off is
 * correct); only the pause latch needs this stricter test.
 */
export function isPersistentWall(msg: string | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.includes('rate limit') || m.includes('too many requests') || /\b429\b/.test(m)) return false;
  return isHaltingError(msg);
}

/**
 * The provider error text on an agent run, or undefined if nothing failed.
 *
 * Its own function because the obvious version of this line was wrong twice over
 * and both mistakes were invisible from the call site.
 *
 * `ok` is about whether the agent finished its work, not about whether a
 * provider answered. The drafter's argument picker fails closed: the provider is
 * down, no argument comes back, the run writes a note explaining the skip, and
 * that note is written successfully — so `ok` is TRUE on exactly the runs where
 * the LLM is dead. Guarding on `!ok` therefore skipped the check precisely when
 * it was needed.
 *
 * And `reason` is a stable code that belongs in a tally, so it must never be the
 * first thing read here: isHaltingError matches words like "insufficient
 * balance" and "402", and no code contains those. Only error_detail carries what
 * the provider actually said. `reason` is the fallback for the older paths that
 * put raw text there, and only when the run failed outright.
 *
 * Both bugs together on 2026-08-23: DeepSeek was out of credit, the pass never
 * stopped, and 43 accounts each got a note saying their facts had been read and
 * no argument fitted.
 */
export function haltingErrorText(r: { ok: boolean; reason?: string; error_detail?: string }): string | undefined {
  return r.error_detail ?? (r.ok ? undefined : r.reason);
}

/** Which provider a halting error came from, for the paused message. */
function providerFromError(msg: string): string | undefined {
  const m = msg.toLowerCase();
  if (m.includes('hunter')) return 'hunter';
  if (m.includes('explorium')) return 'explorium';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('openai') || m.includes('gateway')) return 'llm';
  return undefined;
}

export interface Scored {
  entity_id: string; tot: number; sig: number; ev: number;
  /**
   * Does this account hold a dated event inside the freshness window — a reason
   * to write today. Filled by loadAnchoredAccounts; false when the walk has not
   * been given the anchored set (nothing in the book qualifies, or an older
   * caller), which then behaves as it always did.
   */
  anchor?: boolean;
  /**
   * When that event actually happened, ISO. Undefined when there is no anchor,
   * and undefined is also what an older caller passes, in which case the walk
   * orders exactly as it did before this field existed.
   *
   * Separate from `anchor` because the two answer different questions and only
   * one of them is a bar: `anchor` decides whether the account can be drafted at
   * all, `anchorAt` decides who goes first among the ones that can.
   */
  anchorAt?: string;
}

/**
 * The order the walk visits accounts in.
 *
 * This pass exists to find accounts that clear all three draft bars, and it does
 * nothing at all for an account that misses them — it tallies `below_draft_gates`
 * and moves on. So the order has to put the accounts that can clear the bars
 * first, and the cap has to be reached only after them.
 *
 * It used to sort on `tot` alone, which is the wrong number for that job on two
 * counts. Measured on the Sudden book (2,191 scored accounts):
 *
 *   1. `tot` barely moves with the bar that actually decides. 67 accounts cleared
 *      all three bars; sorting by `tot` and cutting at 400 reached 51 of them and
 *      never looked at the other 16. Ordering by the bars reaches 67 of 67.
 *   2. `tot` is not even an ordering over most of the book. 1,060 of those 2,191
 *      accounts hold the identical score of 0.84, because they are CSV rows that
 *      carry the same five columns and have never been researched, so every
 *      dimension behind the score reads the same for all of them. Sorting on a
 *      1,060-way tie leaves the order to whatever the query returned, and since
 *      that is stable, the same accounts won the tie every single day.
 *
 * The scarce, time-bound input is the anchor: a dated event inside the freshness
 * window. It is the one thing that says something is happening at this company
 * right now, and it is rare — a few dozen accounts on a book of two thousand.
 * Leading with it costs nothing, because everything below still falls back to
 * `tot`, so no account loses its place to anything but a stronger reason to write.
 *
 * This used to lead with `signal_strength`, which reads as a timing signal and is
 * not one: the rubric behind it asks how actionable the latest signal is for what
 * we sell. Wedotv scored 0.70 on launches the drafter then refused to use, while
 * a signed nine-channel European distribution agreement scored 0.4.
 *
 * NaN-safe on purpose: `loadCurrentScores` only requires `tot` to parse, so an
 * account with no `score_signal_strength` row yet carries `sig = NaN`. NaN in a
 * comparator makes the whole sort undefined, and it must rank last rather than
 * anywhere, so it is read as 0 here — the same fail-closed reading `clearsGates`
 * gives it.
 */
export function compareWalkOrder(
  a: Scored,
  b: Scored,
  clearsGates: (s: Scored) => boolean,
): number {
  const num = (x: number) => (Number.isFinite(x) ? x : 0);
  // 1. Can draft right now, given a contact. Phase 1 acts on exactly these.
  const ga = clearsGates(a) ? 1 : 0, gb = clearsGates(b) ? 1 : 0;
  if (ga !== gb) return gb - ga;
  // 2. Has a real reason to write, even if another bar is short.
  const sa = a.anchor ? 1 : 0, sb = b.anchor ? 1 : 0;
  if (sa !== sb) return sb - sa;
  // 3. FRESHEST reason first. Among accounts that can all be written to today,
  //    the one whose event happened most recently goes first, because that is the
  //    only input here that expires. Everything below this line is a property of
  //    the company and will read the same tomorrow; the age of the event will
  //    not, and once it passes trigger_fresh_days the account stops being
  //    writable at all.
  //
  //    Parsed rather than string-compared: `happened_at` reaches here from a
  //    PostgREST read and a backfill script, and one of those could hand over a
  //    bare date while the other sends a full timestamp. Unparseable sorts last
  //    rather than anywhere, the same fail-closed reading `sig` gets below.
  //
  //    Unknown age is `null` and ranks after any known one, rather than being
  //    read as "infinitely old". Reading it as -Infinity would look equivalent
  //    and is not: the subtraction then returns Infinity, which is not a finite
  //    comparator result, and a comparator that can return a non-finite number
  //    is one bad input away from an undefined sort.
  const at = (s: Scored) => { const t = s.anchorAt ? Date.parse(s.anchorAt) : NaN; return Number.isFinite(t) ? t : null; };
  const ta = at(a), tb = at(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  // 4. Strength of that reason, then fit.
  if (Math.abs(num(b.sig) - num(a.sig)) > 1e-9) return num(b.sig) - num(a.sig);
  if (Math.abs(num(b.tot) - num(a.tot)) > 1e-9) return num(b.tot) - num(a.tot);
  // 5. A stable, arbitrary-but-fixed last resort so the sort is deterministic
  //    rather than dependent on the order rows came back in.
  return a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0;
}

/** Current (not-superseded) score facts per account. The current row is the one
 *  no other row points at via `supersedes`. Paged so a big workspace doesn't cap. */
async function loadCurrentScores(supabase: SupabaseClient, workspace_id: string): Promise<Scored[]> {
  const PAGE = 1000;
  const rows: Array<{ id: string; subject_entity: string; predicate: string; object_text: string | null; supersedes: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('facts')
      .select('id, subject_entity, predicate, object_text, supersedes')
      .eq('workspace_id', workspace_id)
      .in('predicate', ['score_total', 'score_signal_strength', 'score_evidence_depth'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const pointed = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const byEnt = new Map<string, Scored>();
  for (const r of rows) {
    if (pointed.has(r.id)) continue;
    const e = byEnt.get(r.subject_entity) ?? { entity_id: r.subject_entity, tot: NaN, sig: NaN, ev: NaN };
    const v = parseFloat(r.object_text ?? '');
    if (r.predicate === 'score_total') e.tot = v;
    else if (r.predicate === 'score_signal_strength') e.sig = v;
    else if (r.predicate === 'score_evidence_depth') e.ev = v;
    byEnt.set(r.subject_entity, e);
  }
  return [...byEnt.values()].filter((e) => Number.isFinite(e.tot));
}

/**
 * The accounts holding at least one dated event inside the freshness window.
 *
 * One query for the whole book. The per-account version of this test lives in
 * agent_logic, which is authoritative — it also knows which anchors have already
 * been spent on an earlier message. This one exists so the walk can ORDER by it
 * and stop spending its 400-account budget on companies where nothing happened.
 * A small disagreement between the two is fine and self-correcting: an account
 * that reaches the drafter and turns out to have no unspent anchor is skipped
 * there, at the cost of one cheap read.
 */
async function loadAnchoredAccounts(
  supabase: SupabaseClient, workspace_id: string, freshDays: number,
): Promise<Map<string, string>> {
  const since = new Date(Date.now() - freshDays * 86400_000).toISOString();
  const PAGE = 1000;
  const rows: Array<{ subject_entity: string; id: string; supersedes: string | null; happened_at: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('facts')
      .select('subject_entity, id, supersedes, happened_at')
      .eq('workspace_id', workspace_id)
      .not('happened_at', 'is', null)
      .gte('happened_at', since)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  // Stale means ANOTHER row points at it. Collected across every page first,
  // then applied per row — deciding it a page at a time would drop an account
  // whose superseding row happened to land on the next page, and deciding it per
  // ACCOUNT would drop an account that still holds a second live anchor.
  const pointedAt = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  // The FRESHEST live anchor per account, not just whether one exists. That date
  // is what the walk orders on, and it has to be the newest one: an account
  // holding a two-day-old launch and a three-week-old hire is a two-day-old
  // reason to write, and taking the older of the two would bury it.
  const out = new Map<string, string>();
  for (const r of rows) {
    if (pointedAt.has(r.id)) continue;
    const held = out.get(r.subject_entity);
    if (!held || r.happened_at > held) out.set(r.subject_entity, r.happened_at);
  }
  return out;
}

/** Pick a current substantive fact to use as the drafter's "what changed" trigger.
 *  Prefers a real hook (buying_signal / recent_event / pain / hiring) over a
 *  generic attribute. Returns null when the account has no substantive fact. */
async function pickTriggerFactId(supabase: SupabaseClient, workspace_id: string, entity_id: string): Promise<string | null> {
  const { data } = await supabase
    .from('facts')
    .select('id, predicate, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id);
  const rows = (data ?? []) as Array<{ id: string; predicate: string; supersedes: string | null }>;
  const pointed = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const current = rows.filter(
    (r) => !pointed.has(r.id) && !r.predicate.startsWith('score_') &&
      !['icp_fit', 'icp_fit_breakdown', 'contact_score', 'dropped_until', 'outreach_cooldown_until'].includes(r.predicate),
  );
  const HOOKS = ['buying_signal', 'recent_event', 'pain_observed', 'hiring_role'];
  return (current.find((r) => HOOKS.includes(r.predicate)) ?? current[0])?.id ?? null;
}

export async function advanceAccounts(
  supabase: SupabaseClient,
  opts: AdvanceOptions,
): Promise<AdvanceResult> {
  const { workspace_id } = opts;
  const contactCap = opts.contactCap ?? 8;
  const draftCap = opts.draftCap ?? 12;
  const maxAccounts = opts.maxAccounts ?? 400;

  const out: AdvanceResult = { scanned: 0, contacts_pulled: 0, contacts_created: 0, drafts_created: 0, decisions: {}, examples: {} };

  // Paused = a prior run hit a credit/auth wall and is waiting for the operator
  // to top up and click Continue (which clears the flag). A contacts-scoped pause
  // (contact-lookup provider out of credit) only blocks phase 2 — drafting accounts
  // that already have a reachable contact needs no lookups and keeps running. A
  // research-scoped pause (Exa out of credit) doesn't block this pass at all —
  // it only stops the research loop. Only an LLM-scoped ('all') pause stops the
  // whole pass: every step after it would fail the same way.
  const status = await getPipelineStatus(supabase, workspace_id);
  const pausedScope = status?.state === 'paused' ? (status.scope ?? 'all') : null;
  const contactsPaused = pausedScope === 'contacts';
  if (pausedScope === 'all') { out.paused = status ?? undefined; return out; }
  if (contactsPaused || pausedScope === 'research') out.paused = status ?? undefined;

  const policy = await getPolicy(supabase, workspace_id);
  const T = buildThresholds(policy.routing, policy.drafter?.outreach_channel);

  // The active drafter subscription — its owner_id is the "agent" runAgent needs,
  // and its id is what pins behavior='drafter'. No drafter configured → we can
  // still pull contacts, but can't draft; that's a setup gap, not a crash.
  const drafterSub = (await supabase
    .from('subscriptions')
    .select('id, owner_id')
    .eq('workspace_id', workspace_id)
    .eq('agent_behavior', 'drafter')
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()).data as { id: string; owner_id: string } | null;

  // Which accounts have a dated reason to write. This is the condition that
  // replaced signal_strength; see compareWalkOrder and action_selector. Gating on
  // the score instead was blocking 49 of the 79 accounts on this book that had a
  // genuine recent event, including a signed nine-channel European distribution
  // agreement scored 0.4 for "passive presence".
  const anchored = await loadAnchoredAccounts(
    supabase, workspace_id, policy.drafter?.trigger_fresh_days ?? DEFAULT_ANCHOR_FRESH_DAYS,
  );

  const clearsGates = (s: Scored) =>
    s.tot >= T.DRAFT_ICP_TOTAL && !!s.anchor && s.ev >= T.DRAFT_EVIDENCE_DEPTH;

  // The `tot` floor stays: an account below it can clear neither the draft bar
  // (0.65) nor the contact-pull bar (0.6), so nothing here could act on it.
  // The ORDER, though, leads with the bars this pass decides on — see
  // compareWalkOrder for why `tot` alone reached only 51 of 67 draftable
  // accounts on the live book.
  const scores = (await loadCurrentScores(supabase, workspace_id))
    .filter((s) => s.tot >= T.ENRICH_CONTACTS_ACCOUNT_ICP)   // only invest in real fits
    .map((s) => ({ ...s, anchor: anchored.has(s.entity_id), anchorAt: anchored.get(s.entity_id) }))
    .sort((a, b) => compareWalkOrder(a, b, clearsGates))
    .slice(0, maxAccounts);

  // Names, for readable progress logging. Chunked so a big id list can't
  // overflow the request URL (PostgREST caps around a few hundred ids).
  const nameById = new Map<string, string>();
  for (let i = 0; i < scores.length; i += 150) {
    const ids = scores.slice(i, i + 150).map((s) => s.entity_id);
    const { data } = await supabase.from('entities').select('id, name').in('id', ids);
    for (const e of (data ?? []) as Array<{ id: string; name: string }>) nameById.set(e.id, e.name);
  }

  // Skip re-pulling contacts for an account we already tried recently (a matched-
  // but-found-nobody account shouldn't burn a credit every night).
  const completed = await latestMarkerByEntity(
    supabase, workspace_id, scores.map((s) => s.entity_id), [ACTIVITY_MARKERS.CONTACTS_COMPLETED],
  );
  const pullCooldownMs = T.ENRICH_CONTACTS_COOLDOWN_DAYS * 86400_000;

  const log = opts.onEvent ?? (() => {});
  const tally = (k: string, name?: string) => {
    out.decisions[k] = (out.decisions[k] ?? 0) + 1;
    if (!name) return;
    const ex = out.examples[k] ?? (out.examples[k] = []);
    if (ex.length < DECISION_EXAMPLES) ex.push(name);
  };
  // Set when the LLM itself hits a wall — every remaining step would fail the
  // same way, so the whole pass unwinds. A contact-provider wall never sets this;
  // it only ends phase 2 (see below).
  let halted = false;

  // Draft one account. runAgent(behavior=drafter) is authoritative — it re-runs
  // selectAction and the drafter's own quality check; we only call it once the
  // account clears the gates and has a reachable contact, to avoid a wasted LLM
  // call. Returns 'paused' to unwind the whole run on an LLM credit/auth wall.
  async function draftAccount(s: Scored, name: string): Promise<'drafted' | 'skip' | 'paused'> {
    if (out.drafts_created >= draftCap) { tally('draft_cap_reached', name); return 'skip'; }
    const factId = await pickTriggerFactId(supabase, workspace_id, s.entity_id);
    if (!factId) { tally('no_trigger_fact', name); return 'skip'; }
    const r = await runAgent(supabase, {
      workspace_id, agent: drafterSub!.owner_id, subscription_id: drafterSub!.id, fact_id: factId,
    });
    const reason = (r as { reason?: string }).reason;
    // Reads the provider's own words, and reads them whether or not the run
    // reported itself ok. See haltingErrorText for why both halves of that
    // matter and what each one cost.
    const errText = haltingErrorText(r);
    if (isHaltingError(errText)) {
      // Stop the run either way (hammering a rate-limited provider helps nobody),
      // but only latch a pause for a wall that will still be there next tick.
      halted = true;
      if (isPersistentWall(errText)) {
        out.paused = await pause(supabase, workspace_id, providerFromError(errText ?? ''), errText ?? 'llm error', 'all');
        return 'paused';
      }
      tally('rate_limited', name);
      return 'skip';
    }
    if (r.ok && r.action === 'post_touch_draft') { out.drafts_created++; tally('drafted', name); log(`  ✎ drafted → ${name}`); return 'drafted'; }
    tally(`skip:${reason ?? r.action}`, name);
    log(`  – ${name}: ${reason ?? r.action}`);
    return 'skip';
  }

  // Phase 1 — draft the accounts that are ready NOW (clear the gates AND already
  // have a reachable contact). No provider spend, so approvals land fast. Strong
  // fits that clear the gates but lack a contact are queued for phase 2.
  const needy: Array<{ s: Scored; name: string }> = [];
  for (const s of scores) {
    if (halted) break;
    out.scanned++;
    const name = nameById.get(s.entity_id) ?? s.entity_id.slice(0, 8);
    if (!clearsGates(s)) { tally('below_draft_gates', name); continue; }
    // On a channel that does not need an address, a missing recipient is not a
    // reason to withhold a draft — see REQUIRE_CONTACT. Half the accounts that
    // clear every bar on this book have nobody attached, and they were queueing
    // for a contact pull every night against a provider that came back empty.
    if (!T.REQUIRE_CONTACT) { await draftAccount(s, name); continue; }
    const best = await loadBestContactScore(supabase, workspace_id, s.entity_id);
    if (drafterSub && best !== undefined && best >= T.DRAFT_MIN_CONTACT_SCORE) {
      await draftAccount(s, name);
    } else {
      needy.push({ s, name });   // clears gates, no reachable contact → phase 2
    }
  }

  // Phase 2 — spend the contact budget on the queued strong fits, best first,
  // then draft the ones a pull unlocked. Slower and costs credits, so it runs
  // after the free wins and stops at the per-run cap (or a credit wall). Skipped
  // outright while a contacts-scoped pause is standing.
  for (const { s, name } of needy) {
    if (halted || contactsPaused || out.paused?.scope === 'contacts') break;
    if (out.contacts_pulled >= contactCap || out.drafts_created >= draftCap) break;
    const lastPull = completed.get(s.entity_id);
    if (lastPull !== undefined && Date.now() - lastPull < pullCooldownMs) { tally('pull_cooldown', name); continue; }
    out.contacts_pulled++;
    log(`  ⟳ pulling contacts → ${name}`);
    const pull = await pullContactsForAccount(supabase, { workspace_id, entity_id: s.entity_id });
    out.contacts_created += pull.created;
    if (!pull.ok && isHaltingError(pull.error_detail ?? pull.reason)) {
      // A pull can fail on the lookup provider (Hunter/Explorium — contacts-only
      // problem) or on the LLM that scores the pulled contacts (everything after
      // this would fail too). Scope the pause accordingly.
      const errText = pull.error_detail ?? pull.reason ?? 'provider error';
      const who = pull.provider ?? providerFromError(errText);
      const llmWall = who === 'deepseek' || who === 'llm';
      // Same split as drafting: back off this run on any halting error, but only
      // latch a pause when the wall will outlast the tick. A rate-limited contact
      // provider used to pause contact pulls until someone noticed and clicked.
      if (isPersistentWall(errText)) {
        out.paused = await pause(supabase, workspace_id, who, errText, llmWall ? 'all' : 'contacts');
      } else {
        tally('rate_limited');
      }
      if (llmWall) halted = true;
      break;
    }
    if (pull.created > 0) {
      const best = await loadBestContactScore(supabase, workspace_id, s.entity_id);
      if (best !== undefined && best >= T.DRAFT_MIN_CONTACT_SCORE) await draftAccount(s, name);
      else { tally('contact_below_bar', name); log(`  – ${name}: pulled contact but scored below bar`); }
    } else { tally('no_contact_found', name); log(`  – ${name}: no contact found`); }
  }

  // The decision tally is the only record of what the pass DIDN'T do and why —
  // 350 accounts below the gates, 8 with no fresh trigger, 4 short on facts. It
  // used to live in memory and die with the run, so `pnpm report` could show the
  // one draft that happened and nothing about the 399 accounts that didn't. The
  // pipeline status carries only the latest run's counts; a window report needs
  // one row per run, so it goes to the event log.
  async function recordRun() {
    await supabase.from('events').insert({
      workspace_id,
      actor_kind: 'system',
      actor_id: 'advance_accounts',
      action: 'advance_completed',
      target_kind: 'workspace',
      target_id: workspace_id,
      payload: {
        scanned: out.scanned,
        contacts_pulled: out.contacts_pulled,
        contacts_created: out.contacts_created,
        drafts_created: out.drafts_created,
        decisions: out.decisions,
        examples: out.examples,
        halted,
        paused: out.paused ? `${out.paused.scope ?? 'all'}: ${out.paused.reason}` : null,
      },
    });
  }

  if (halted) { await recordRun(); return out; }
  await recordRun();

  const runStats = {
    scanned: out.scanned, contacts_pulled: out.contacts_pulled,
    contacts_created: out.contacts_created, drafts_created: out.drafts_created,
  };
  if (out.paused && out.paused.scope !== 'all') {
    // Keep the contacts/research pause standing (the operator still has to fix
    // the provider and click Continue) but record that this run did its drafting.
    await setPipelineStatus(supabase, workspace_id, {
      ...out.paused, last_run_at: new Date().toISOString(), last_run: runStats,
    });
    return out;
  }
  await setPipelineStatus(supabase, workspace_id, {
    state: 'ok',
    last_run_at: new Date().toISOString(),
    last_run: runStats,
  });
  return out;
}

/**
 * Daily cloud run of the advance pass, so drafting happens even when the
 * operator's machine is off. 14:30 UTC sits after the 12:00 research tick and
 * the ~13:00 source runs have landed fresh facts, and before the local launchd
 * fallback (16:00 UTC) — which then mostly no-ops via DRAFT_SUPPRESSION_DAYS
 * and the contact-pull cooldown, so running both is safe, not double spend.
 * Caps come from workspaces.policy.enrichment (the Settings UI), same as the
 * local loop.
 */
export const advanceAccountsCron = inngest.createFunction(
  { id: 'advance-accounts-daily', concurrency: { limit: 1 } },
  // Cron for the daily tick + an event trigger so the pass can be kicked on
  // demand (verification, a future "run now" button) without waiting for 14:30.
  [{ cron: '30 14 * * *' }, { event: 'advance.requested' }],
  async ({ step }) =>
    step.run('advance-all-workspaces', async () => {
      const supabase = createServerClient();
      const wss = await supabase.from('workspaces').select('id, policy');
      const results: Record<string, unknown> = {};
      for (const w of (wss.data ?? []) as Array<{ id: string; policy: { enrichment?: { max_contact_pulls_per_run?: number; max_drafts_per_run?: number } } | null }>) {
        try {
          const enr = w.policy?.enrichment;
          const a = await advanceAccounts(supabase, {
            workspace_id: w.id,
            contactCap: enr?.max_contact_pulls_per_run ?? 8,
            draftCap: enr?.max_drafts_per_run ?? 12,
          });
          results[w.id] = {
            scanned: a.scanned, contacts_pulled: a.contacts_pulled,
            contacts_created: a.contacts_created, drafts_created: a.drafts_created,
            paused: a.paused ? `${a.paused.scope ?? 'all'}: ${a.paused.reason}` : undefined,
          };
        } catch (e) {
          results[w.id] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return results;
    }),
);

async function pause(supabase: SupabaseClient, workspace_id: string, provider: string | undefined, reason: string, scope: 'contacts' | 'all'): Promise<PipelineStatus> {
  const status: PipelineStatus = {
    state: 'paused',
    scope,
    provider,
    reason: humanizeReason(provider, reason) + (scope === 'contacts' ? ' Drafting continues for accounts that already have a contact.' : ''),
    paused_at: new Date().toISOString(),
  };
  await setPipelineStatus(supabase, workspace_id, status);
  return status;
}

/** Turn a raw provider error into one plain sentence a non-engineer can act on. */
function humanizeReason(provider: string | undefined, raw: string): string {
  const r = raw.toLowerCase();
  const who = provider === 'deepseek' || provider === 'llm' ? 'The AI model provider'
    : provider === 'hunter' ? 'Hunter (contact lookup)'
    : provider === 'explorium' ? 'Explorium (contact lookup)'
    : 'A provider';
  if (r.includes('insufficient balance') || r.includes('credit') || r.includes('payment required') || r.includes('402')) {
    return `${who} is out of credit. Add funds, then click Continue.`;
  }
  if (r.includes('rate limit') || r.includes('too many requests') || r.includes('429')) {
    return `${who} hit its rate limit. Wait a few minutes, then click Continue.`;
  }
  if (r.includes('unauthorized') || r.includes('invalid api key') || r.includes('401')) {
    return `${who} rejected the API key. Fix the key in Setup, then click Continue.`;
  }
  return `${who} returned an error: ${raw.slice(0, 160)}`;
}
