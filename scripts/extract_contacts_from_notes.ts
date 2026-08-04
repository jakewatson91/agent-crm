/**
 * Promote people named in free-text notes into real contact entities.
 *
 * Why: the drafter needs a person, not an email. Templates select on audience
 * (connector / founder / technical owner) and every message opens with a first
 * name, so an account with no contact cannot be drafted at all — action_selector
 * requires a scored contact before draft_outreach. Meanwhile contact enrichment
 * runs on Hunter, which finds EMAIL addresses that a LinkedIn workspace never
 * uses, capped at 50/month against ~900 accounts.
 *
 * Some of those people are already in the CRM, sitting in imported note text.
 * Intigral's notes name "Bill Sharp (CTO)" and "Hazem Alzein (Broadcast Eng
 * Manager)"; neither was ever a contact entity. This extracts them. No provider,
 * no cap, no per-contact cost beyond one cheap completion per note.
 *
 * THE DATA IS MESSY AND THE PROMPT IS STRICT ON PURPOSE. Notes routinely name
 * people who must NOT become contacts of the account:
 *   - intermediaries: "Through Mohsen Lhaf", "Introduced to Sam through Kirsti"
 *   - people who have left: "still connected to decision makers, even if they
 *     left in 2017"
 *   - a name next to a LinkedIn URL belonging to someone else entirely
 *     ("Andrea Meneses - linkedin.com/in/ryan-barnes-...")
 *   - bare pronouns: "She reached out on linkedin"
 * A wrong contact is worse than no contact, because the drafter will open a
 * message to that person by name. When in doubt the extractor returns nothing.
 *
 * Model: deepseek-v4-flash, matching classify_role.ts — the closest existing
 * task (cheap structured extraction). Not a swap of any configured model.
 *
 * Writes via linkContactByProspectId, which is idempotent on (account,
 * lowercased name), so re-running cannot duplicate.
 *
 * Usage: tsx scripts/extract_contacts_from_notes.ts           (dry run)
 *        tsx scripts/extract_contacts_from_notes.ts --apply
 *        LIMIT=25 tsx scripts/extract_contacts_from_notes.ts  (sample first)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace, linkContactByProspectId } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;

/** Predicates holding free-text notes. Data values from the CSV import, not a
 *  shared-code convention, so they live here rather than in the pipeline. */
const NOTE_PREDICATES = ['prospect_notes'];

const SYS = `You pull colleagues' names out of a sales note and return them as structured data.

You are given a COMPANY and a NOTE someone on the sales team wrote about it. Return only people who WORK AT THAT COMPANY RIGHT NOW.

Return nobody, and an empty list, when the note only records outreach history ("cold email", "reached out via RocketReach", "part of a survey").

NEVER return:
- an intermediary or referrer: someone the note went "through", who "introduced" the writer, a channel partner, a mutual connection
- anyone the note says has LEFT that company, or works somewhere else
- the note's own author, or the salesperson
- a pronoun with no name attached ("she reached out", "worked closely with him") — no name means no person
- a name you inferred from a LinkedIn URL slug rather than read in the text

A LinkedIn URL belongs to a person ONLY if the slug plausibly matches the name you are returning. Notes often paste a URL next to an unrelated name. If the slug and the name disagree, return the name with no URL.

role: only if the note states it. Never guess a role from the company's industry.

If you are unsure whether someone still works there, leave them out. A wrong name is worse than a missing one, because a message will be addressed to them.

Output JSON only:
{"people":[{"name":"<as written>","role":"<stated role or null>","linkedin_url":"<matching url or null>"}]}`;

interface Person { name: string; role: string | null; linkedin_url: string | null }

async function extract(company: string, note: string): Promise<Person[]> {
  try {
    const r = await chatCompleteForWorkspace(sb as never, WS, {
      model: 'deepseek-v4-flash',
      behavior: 'enricher',
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `COMPANY: ${company}\n\nNOTE:\n${note}` },
      ],
    } as never);
    const parsed = JSON.parse(String((r as { text: string }).text ?? '{}'));
    const people = Array.isArray(parsed.people) ? parsed.people : [];
    return people
      .filter((p: Person) => p && typeof p.name === 'string' && p.name.trim().split(/\s+/).length >= 2)
      .map((p: Person) => ({
        name: p.name.trim(),
        role: typeof p.role === 'string' && p.role.trim() ? p.role.trim() : null,
        linkedin_url: typeof p.linkedin_url === 'string' && /linkedin\.com\/in\//i.test(p.linkedin_url) ? p.linkedin_url.trim() : null,
      }));
  } catch {
    return [];
  }
}

async function main() {
  // Active notes only (nothing supersedes them).
  const noteRows: Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', WS).in('predicate', NOTE_PREDICATES).order('id').range(f, f + 999);
    if (error) throw error;
    const page = (data ?? []) as typeof noteRows;
    noteRows.push(...page);
    if (page.length < 1000) break;
  }
  const superseded = new Set(noteRows.map((r) => r.supersedes).filter(Boolean));
  const active = noteRows.filter((r) => !superseded.has(r.id) && String(r.object_text ?? '').trim().length > 25);

  // Accounts that already have a contact need nothing, and accounts vetoed out
  // of scope must not get one — finding a contact for a company we cannot serve
  // just spends money to make a bad account look draftable.
  const withContact = new Set<string>();
  const { data: wa } = await sb.from('facts').select('object_entity')
    .eq('workspace_id', WS).eq('predicate', 'works_at').is('supersedes', null);
  for (const r of (wa ?? []) as Array<{ object_entity: string }>) if (r.object_entity) withContact.add(r.object_entity);

  const outOfScope = new Set<string>();
  const bdRows: Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }> = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', WS).eq('predicate', 'icp_fit_breakdown').order('id').range(f, f + 999);
    const page = (data ?? []) as typeof bdRows;
    bdRows.push(...page);
    if (page.length < 1000) break;
  }
  const bdSup = new Set(bdRows.map((r) => r.supersedes).filter(Boolean));
  for (const r of bdRows.filter((x) => !bdSup.has(x.id))) {
    try { if (JSON.parse(r.object_text).out_of_scope) outOfScope.add(r.subject_entity); } catch { /* ignore */ }
  }

  const eligible = active.filter((r) => !withContact.has(r.subject_entity) && !outOfScope.has(r.subject_entity));
  const todo = LIMIT ? eligible.slice(0, LIMIT) : eligible;

  const { data: ents } = await sb.from('entities').select('id, name').in('id', [...new Set(todo.map((r) => r.subject_entity))]);
  const names = new Map(((ents ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));

  console.log(`${active.length} active notes · ${active.length - eligible.length} skipped (account already has a contact, or is out of scope) · ${eligible.length} eligible`);
  console.log(`scanning ${todo.length}${LIMIT && eligible.length > LIMIT ? ` (LIMIT=${LIMIT})` : ''}…\n`);

  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'notes_contact_extractor' };
  let found = 0, created = 0, accountsWith = 0;
  for (const r of todo) {
    const company = names.get(r.subject_entity) ?? '(unknown)';
    const people = await extract(company, String(r.object_text));
    if (!people.length) continue;
    accountsWith++;
    found += people.length;
    console.log(`${company}`);
    for (const p of people) {
      console.log(`    ${p.name}${p.role ? `  [${p.role}]` : ''}${p.linkedin_url ? `  ${p.linkedin_url}` : ''}`);
      if (!APPLY) continue;
      try {
        const res = await linkContactByProspectId(sb as never, actor, {
          account_entity_id: r.subject_entity, name: p.name,
          role: p.role ?? undefined, linkedin_url: p.linkedin_url ?? undefined,
        });
        if (res.created) created++;
      } catch (e) {
        console.log(`      WRITE FAILED: ${(e as Error).message.slice(0, 90)}`);
      }
    }
  }

  console.log(`\n${found} people across ${accountsWith} accounts (of ${todo.length} notes scanned)`);
  if (APPLY) console.log(`${created} contact entities created`);
  else console.log('DRY RUN. Re-run with --apply to write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
