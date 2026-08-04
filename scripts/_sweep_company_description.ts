/**
 * Read-only sweep: find company_description facts that actually describe a
 * PERSON, not the company.
 *
 * Why it matters: scoring.ts renders company_description into the ICP rubric and
 * the drafter renders it as account context. TVU Networks carries
 * "Ex-AWS, Principal Partner Solutions Architect, Media & Entertainment. My role
 * involves aligning AWS partner initiatives..." — a contact's LinkedIn bio filed
 * as a fact about the account. industry_match is being judged off someone's
 * resume, and the drafter can repeat it back to them as if it described their
 * employer.
 *
 * Two-stage on purpose: a cheap first-person/resume heuristic shortlists
 * candidates so we don't pay a completion for all ~900 rows, then the shortlist
 * is printed for judgement. The heuristic only decides what to LOOK at; it never
 * decides what is wrong.
 *
 * Usage: tsx scripts/_sweep_company_description.ts [predicate]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const PRED = process.argv[2] ?? 'company_description';

/** Written in the first person: a company profile never says "my role". */
const FIRST_PERSON = /\b(I|I'm|I've|my|My)\s+(am|role|work|drive|lead|manage|help|focus|have|run|report)\b|\bMy role\b|\bI drive\b|\bI lead\b|\bI manage\b/;
/** CV furniture: phrases that belong on a profile, not on a company page. */
const RESUME = /\b(years? \d+ months?|\d+ years? \d+ months? of experience|Previous roles include|Ex-[A-Z]|currently (?:a|an|the) [A-Z]|reports? to the|Based in [A-Z][a-z]+,? [A-Z]{2}\b)/;
/** A job title standing where a company description should be. "Global " was
 *  here and matched company names outright ("Global TV is a free streaming
 *  service…"), so it is gone: a shortlisting heuristic that flags real rows
 *  wastes the reviewer's attention, which is the scarce thing. */
const TITLE_LEAD = /^(Ex-|Former |Senior |Principal |Head of |VP |Vice President|Director of|Chief )/;

async function main() {
  const rows: Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null; observed_at: string }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from('facts').select('id, subject_entity, object_text, supersedes, observed_at')
      .eq('workspace_id', WS).eq('predicate', PRED).order('id').range(f, f + 999);
    if (error) throw error;
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  // Activeness must be checked across ALL predicates, not just this one. A fact
  // moved to a different predicate is superseded by a row this query never sees,
  // so collecting supersedes pointers from the result set alone reports moved
  // rows as still active — which is exactly what happened right after
  // fix_misfiled_facts.ts ran and made the fix look like a no-op.
  const ids = rows.map((r) => r.id);
  const superseded = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('facts').select('supersedes')
      .eq('workspace_id', WS).in('supersedes', ids.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ supersedes: string }>) if (r.supersedes) superseded.add(r.supersedes);
  }
  const active = rows.filter((r) => !superseded.has(r.id));

  const hits = active.map((r) => {
    const t = String(r.object_text ?? '');
    const why: string[] = [];
    if (FIRST_PERSON.test(t)) why.push('first-person');
    if (RESUME.test(t)) why.push('resume-phrase');
    if (TITLE_LEAD.test(t.trim())) why.push('opens-with-job-title');
    return { ...r, t, why };
  }).filter((r) => r.why.length);

  const { data: ents } = await sb.from('entities').select('id, name').in('id', [...new Set(hits.map((h) => h.subject_entity))].slice(0, 300));
  const names = new Map(((ents ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));

  console.log(`predicate "${PRED}": ${rows.length} rows, ${active.length} active`);
  console.log(`SUSPECT (describes a person, not the company): ${hits.length}  (${((hits.length / Math.max(active.length, 1)) * 100).toFixed(1)}%)\n`);
  for (const h of hits) {
    console.log(`── ${names.get(h.subject_entity) ?? h.subject_entity.slice(0, 8)}   [${h.why.join(', ')}]`);
    console.log(`   ${h.t.slice(0, 260).replace(/\s+/g, ' ')}`);
    console.log(`   fact ${h.id}`);
  }
  if (!hits.length) console.log('(none matched the heuristic — does not prove the field is clean, only that these patterns are absent)');
}
main().catch((e) => { console.error(e); process.exit(1); });
