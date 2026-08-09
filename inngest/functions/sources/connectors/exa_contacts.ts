/**
 * Contact-signal Exa connector. Self-sources a real, recent web signal for the
 * PEOPLE in the workspace (not the companies) so the contact scorer's
 * `signal_strength` slot runs on a detected event instead of a hand-written one.
 *
 * Why this is its own connector and not the existing `exa` watch mode: watch mode
 * runs ONE broad query per run and matches results against watched entities by
 * name. With ~25 results/run, the odds any of them names a specific founder out of
 * a few hundred contacts is near zero — it would silently produce nothing. This
 * connector inverts the loop: for each high-fit contact it issues ONE targeted
 * search (`"Person Name" Company`), which reliably returns that person's footprint.
 *
 * For each candidate contact it asserts the top recent result as a `web_activity`
 * content fact on the contact entity, then re-scores the contact. `scoreContact`
 * reads facts (object_text ≥ 40 chars, non-seed predicate), so the fact directly
 * feeds the signal_strength rubric on the next score.
 *
 * Cost is bounded: only contacts on ICP-fit accounts that lack a recent
 * web_activity fact are searched, capped at `max_contacts` per run. ~$0.005/search.
 *
 * Config (all optional, vertical-neutral defaults):
 *   - since_hours:      recency window for the search (default 720 = 30d)
 *   - max_contacts:     max searches per run, the cost cap (default 10)
 *   - min_account_fit:  only contacts whose account icp_fit ≥ this (default 0.5)
 *   - num_results:      Exa results fetched per contact (default 3)
 *   - cooldown_hours:   skip a contact with a web_activity fact newer than this
 *                       (default 336 = 14d)
 */
import { callTool, entityIdsOfType, scoreAndAssert } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.ts';

export { exaContactsMeta as meta } from '../registry_meta.ts';

const EXA_API = 'https://api.exa.ai/search';

interface ExaResult {
  id: string;
  title: string | null;
  url: string;
  publishedDate?: string;
  text?: string;
}

async function exaSearch(apiKey: string, query: string, sinceHours: number, numResults: number): Promise<ExaResult[]> {
  const startPublishedDate = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const r = await fetch(EXA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: Math.min(numResults, 25),
      contents: { text: { maxCharacters: 1200 } },
      startPublishedDate,
    }),
  });
  if (!r.ok) throw new Error(`Exa ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { results?: ExaResult[] };
  return j.results ?? [];
}

// Strip leading emoji / punctuation junk some providers prepend to names, so the
// search query is the actual person's name. Keeps letters, spaces, hyphens, dots.
function cleanName(name: string): string {
  return name.replace(/[^\p{L}\p{N}\s.'-]/gu, '').replace(/\s+/g, ' ').trim();
}

const exaContacts: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) { result.errors.push('EXA_API_KEY env is not set'); return result; }

  const sinceHours = (ctx.config.since_hours as number) ?? 720;
  const maxContacts = (ctx.config.max_contacts as number) ?? 10;
  const minAccountFit = (ctx.config.min_account_fit as number) ?? 0.5;
  const numResults = (ctx.config.num_results as number) ?? 3;
  const cooldownHours = (ctx.config.cooldown_hours as number) ?? 336;

  // 1) All contact entities in the workspace.
  let contactIds: string[];
  try {
    contactIds = await entityIdsOfType(ctx.supabase, ctx.workspace_id, 'contact');
  } catch (e) {
    result.errors.push(`load contacts failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  if (!contactIds.length) return result;

  const contactsRes = await ctx.supabase.from('entities').select('id, name').in('id', contactIds);
  const contactName = new Map<string, string>();
  for (const c of contactsRes.data ?? []) contactName.set(c.id as string, (c.name as string) ?? '');

  // 2) works_at edges → parent account per contact.
  const worksAt = await ctx.supabase.from('facts')
    .select('subject_entity, object_entity')
    .eq('workspace_id', ctx.workspace_id).eq('predicate', 'works_at')
    .in('subject_entity', contactIds).is('supersedes', null);
  const accountOf = new Map<string, string>();
  for (const f of worksAt.data ?? []) {
    if (f.object_entity) accountOf.set(f.subject_entity as string, f.object_entity as string);
  }

  // 3) Account names + icp_fit for the linked accounts.
  const accountIds = Array.from(new Set([...accountOf.values()]));
  if (!accountIds.length) return result;
  const accountsRes = await ctx.supabase.from('entities').select('id, name').in('id', accountIds);
  const accountName = new Map<string, string>();
  for (const a of accountsRes.data ?? []) accountName.set(a.id as string, (a.name as string) ?? '');

  const fitRes = await ctx.supabase.from('facts')
    .select('subject_entity, object_text, observed_at')
    .eq('workspace_id', ctx.workspace_id).eq('predicate', 'icp_fit')
    .in('subject_entity', accountIds).order('observed_at', { ascending: false });
  const accountFit = new Map<string, number>();
  for (const f of fitRes.data ?? []) {
    const id = f.subject_entity as string;
    if (!accountFit.has(id)) accountFit.set(id, Number(f.object_text) || 0); // first = newest
  }

  // 4) Cooldown: contacts with a recent web_activity fact are skipped.
  const cutoff = Date.now() - cooldownHours * 3600 * 1000;
  const recentAct = await ctx.supabase.from('facts')
    .select('subject_entity, observed_at')
    .eq('workspace_id', ctx.workspace_id).eq('predicate', 'web_activity')
    .in('subject_entity', contactIds)
    .gte('observed_at', new Date(cutoff).toISOString());
  const onCooldown = new Set((recentAct.data ?? []).map((f) => f.subject_entity as string));

  // 5) Candidates: have an account, account clears the fit bar, not on cooldown.
  //    Sort by account fit desc so the best-fit people get the budget first.
  const candidates = contactIds
    .filter((id) => accountOf.has(id) && !onCooldown.has(id))
    .filter((id) => (accountFit.get(accountOf.get(id)!) ?? 0) >= minAccountFit)
    .sort((a, b) => (accountFit.get(accountOf.get(b)!) ?? 0) - (accountFit.get(accountOf.get(a)!) ?? 0))
    .slice(0, maxContacts);

  if (!candidates.length) return result;

  const actor = { workspace_id: ctx.workspace_id, actor_kind: 'agent' as const, actor_id: `source:exa_contacts:${ctx.source_id.slice(0, 8)}` };

  for (const contactId of candidates) {
    const name = cleanName(contactName.get(contactId) ?? '');
    const company = accountName.get(accountOf.get(contactId)!) ?? '';
    if (!name) { result.skipped++; continue; }
    const query = company ? `"${name}" ${company}` : `"${name}"`;

    let results: ExaResult[];
    try {
      results = await exaSearch(apiKey, query, sinceHours, numResults);
    } catch (e) {
      result.errors.push(`exa search "${query}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Top substantive result that is actually ABOUT this person becomes the fact.
    // Requiring the name in title+text drops company-profile / job-board pages that
    // match the company but never mention the contact — the scorer would rate those
    // ~0 anyway, so filtering here saves a wasted score and a noise fact.
    const tokens = name.toLowerCase().split(' ').filter((t) => t.length >= 3);
    const mentionsPerson = (r: ExaResult): boolean => {
      const hay = `${r.title ?? ''} ${r.text ?? ''}`.toLowerCase();
      return hay.includes(name.toLowerCase()) || (tokens.length >= 2 && tokens.every((t) => hay.includes(t)));
    };
    const top = results.find((r) => (r.text ?? '').trim().length >= 80 && mentionsPerson(r));
    if (!top) { result.skipped++; continue; }

    const snippet = (top.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const date = top.publishedDate ? ` (${top.publishedDate.slice(0, 10)})` : '';
    const objectText = `${(top.title ?? 'web mention').trim()}: ${snippet} [${top.url}]${date}`;

    const r = await callTool(ctx.supabase, actor, 'assert_fact', {
      subject_entity: contactId,
      predicate: 'web_activity',
      object_text: objectText.slice(0, 800),
      confidence: 0.6,
    });
    if (!r.ok) { result.errors.push(`assert_fact ${contactId}: ${r.error}`); continue; }
    result.signals_created++;

    // Re-score so the new content fact feeds the contact's signal_strength slot.
    try {
      await scoreAndAssert(ctx.supabase, actor, contactId);
    } catch { /* non-fatal — the fact landed; score will refresh next cron */ }
  }

  return result;
};

export default exaContacts;
