/**
 * Read-only: run the live drafter prompt against ONE named account and print
 * what it decides. _dryrun_drafts.ts walks the top N by score; this is the
 * single-account version for when you already know which account you are
 * arguing about. Same builders, same model, same params. Writes nothing.
 *
 * Usage: tsx scripts/_dryrun_account.ts [entity_id | name fragment]
 * Defaults to TVU Networks, the account whose draft opened this investigation.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace, scoreFacts } from '@agent-crm/tools';
import { buildSystemPrompt, buildUserPrompt } from '../inngest/functions/agent_logic.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const ARG = process.argv[2] ?? '39f75923-e46e-48aa-9524-f009c6be6c70';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveEntity(): Promise<{ id: string; name: string; attributes: unknown }> {
  if (UUID.test(ARG)) {
    const { data } = await sb.from('entities').select('id, name, attributes').eq('id', ARG).maybeSingle();
    if (!data) throw new Error(`no entity with id ${ARG}`);
    return data as any;
  }
  const { data } = await sb.from('entities').select('id, name, attributes')
    .eq('workspace_id', WS).ilike('name', `%${ARG}%`).limit(5);
  const rows = (data ?? []) as any[];
  if (!rows.length) throw new Error(`no entity in Sudden matching "${ARG}"`);
  if (rows.length > 1) console.log(`(${rows.length} matches, using the first: ${rows.map((r) => r.name).join(', ')})`);
  return rows[0];
}

async function main() {
  const { data: w } = await sb.from('workspaces').select('about, constitution, persona, icp, policy').eq('id', WS).single();
  const ws = w as Record<string, any>;
  const policy = (ws.policy ?? {}) as Record<string, any>;

  const system = buildSystemPrompt('drafter', ws.about, ws.constitution, ws.persona, ws.icp, {}, {
    outreach_channel: policy.drafter?.outreach_channel,
    subject_style: policy.drafter?.subject_style,
    paragraph_count: policy.drafter?.paragraph_count,
    pain_points: policy.drafter?.pain_points,
    value_props: policy.drafter?.value_props,
    tone_keywords: policy.drafter?.tone_keywords,
    ask_examples: policy.drafter?.ask_examples,
    forbidden_phrases: policy.outreach?.banned_phrases ?? [],
    forbidden_field_terms: policy.drafter?.forbidden_field_terms ?? [],
    market_brief: policy.drafter?.market_brief,
    templates: policy.drafter?.templates,
    message_rules: policy.drafter?.message_rules,
    char_budget: policy.drafter?.char_budget,
    trigger_max_age_days: policy.drafter?.trigger_max_age_days,
    trigger_fresh_days: policy.drafter?.trigger_fresh_days,
    out_of_scope: policy.drafter?.out_of_scope,
  });

  const ent = await resolveEntity();
  const entityId = ent.id;
  const { data: allFacts } = await sb.from('facts')
    .select('id, predicate, object_text, confidence, observed_at, signal_id, supersedes')
    .eq('workspace_id', WS).eq('subject_entity', entityId);
  const factRows = (allFacts ?? []) as any[];
  const pointed = new Set(factRows.map((f) => f.supersedes).filter(Boolean));
  const activeFacts = factRows.filter((f) =>
    !pointed.has(f.id) && !f.predicate.startsWith('score_') &&
    !['icp_fit', 'icp_fit_breakdown', 'contact_score', 'dropped_until', 'outreach_cooldown_until'].includes(f.predicate));

  const sigIds = [...new Set(activeFacts.map((f) => f.signal_id).filter(Boolean))];
  const dateBySig = new Map<string, string>();
  if (sigIds.length) {
    const { data: srcSigs } = await sb.from('signals').select('id, observed_at, structured_tags').in('id', sigIds);
    for (const s of (srcSigs ?? []) as any[]) {
      const pub = s.structured_tags?.published_at;
      if (pub && Number.isFinite(Date.parse(pub))) dateBySig.set(s.id, pub);
    }
  }
  for (const f of activeFacts) {
    f.source_date = f.signal_id ? dateBySig.get(f.signal_id) : undefined;
    f.recorded_date = f.observed_at;
  }

  // Contacts link via a works_at FACT, which is what action_selector reads and
  // what create_contact writes. Reading attributes.works_at instead (as this
  // script used to) silently reports zero contacts for every account, because
  // nothing sets that attribute. Email is NOT required: on the linkedin channel
  // a name and a role are what the templates need.
  const { data: waFacts } = await sb.from('facts').select('subject_entity')
    .eq('workspace_id', WS).eq('predicate', 'works_at').eq('object_entity', entityId).is('supersedes', null);
  const contactIds = [...new Set(((waFacts ?? []) as any[]).map((r) => r.subject_entity).filter(Boolean))];
  let contacts: Array<{ name: string; email: string; role: string }> = [];
  if (contactIds.length) {
    const { data: cEnts } = await sb.from('entities').select('id, name, attributes').in('id', contactIds);
    const { data: cFacts } = await sb.from('facts').select('subject_entity, predicate, object_text')
      .eq('workspace_id', WS).in('subject_entity', contactIds).in('predicate', ['role', 'email']).is('supersedes', null);
    const byId = new Map<string, { role?: string; email?: string }>();
    for (const f of (cFacts ?? []) as any[]) {
      const e = byId.get(f.subject_entity) ?? {};
      if (f.predicate === 'role') e.role = f.object_text; else e.email = f.object_text;
      byId.set(f.subject_entity, e);
    }
    contacts = ((cEnts ?? []) as any[]).map((c) => ({
      name: c.name,
      email: byId.get(c.id)?.email ?? c.attributes?.email ?? '',
      role: byId.get(c.id)?.role ?? c.attributes?.role ?? c.attributes?.title ?? '',
    }));
  }
  const { data: sig } = await sb.from('signals').select('*').eq('entity_id', entityId).order('observed_at', { ascending: false }).limit(1).maybeSingle();

  let recommended: any[] = [];
  try { recommended = await scoreFacts(sb as any, { workspace_id: WS, entity_id: entityId, facts: activeFacts as any, limit: 5 } as any); } catch { /* optional */ }

  const user = buildUserPrompt('claims_outbound_drafter', 'dry-run', 'dry-run grading pass',
    sig ?? {}, { id: entityId, name: ent.name, attributes: ent.attributes }, activeFacts, [], contacts, recommended as any, true);

  const res = await chatCompleteForWorkspace(sb as any, WS, {
    model: 'deepseek-v4-pro', behavior: 'drafter', max_tokens: 3000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  } as any);

  console.log(`=== drafter output for ${ent.name} (${activeFacts.length} active facts) ===`);
  const parsed = JSON.parse(String(res.text ?? '').replace(/^```json\s*|\s*```$/g, '').trim());
  console.log(`action : ${parsed.action}`);
  console.log(`policy : ${parsed.policy ?? '(none)'}`);
  console.log(`body   : ${parsed.body}`);
  if (parsed.reasoning) console.log(`reason : ${parsed.reasoning}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
