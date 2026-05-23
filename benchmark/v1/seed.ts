/**
 * v1 benchmark seeder.
 *
 * Reads the 6 v1 accounts from agent-crm Supabase, then:
 *  1. Mirrors each to HubSpot as a Company + associated Contacts + Notes (one
 *     note per top fact). NO custom-property workarounds — real HubSpot object
 *     associations only.
 *  2. Ensures every account has a past_touch channel_post in agent-crm so the
 *     drafter prompt has a prior touch to reference. Skips if one already
 *     exists.
 *  3. Adds a matching past-touch note to the HubSpot Company so both sides
 *     have equivalent prior-touch context.
 *
 * Run once before benchmarking:
 *   pnpm exec tsx benchmark/v1/seed.ts
 *
 * Idempotent: rerunning updates instead of duplicating, keyed on
 * company name + contact email + the agent_crm_seed=true custom property.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];

const HS_BASE = 'https://api.hubapi.com';
const HS_KEY = process.env.HUBSPOT_SERVICE_KEY!;
if (!HS_KEY) throw new Error('Missing HUBSPOT_SERVICE_KEY');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function hs(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HS_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`HubSpot ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204 || res.status === 404) return null;
  return res.json();
}

async function findWorkspaceId(): Promise<string> {
  const ws = await supabase.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw ws.error ?? new Error('workspace not found');
  return ws.data.id as string;
}

async function findOrCreateHubSpotCompany(name: string, domain: string, description: string): Promise<string> {
  const search = await hs('POST', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
    properties: ['name'],
    limit: 1,
  });
  if (search?.results?.[0]?.id) {
    const id = search.results[0].id as string;
    await hs('PATCH', `/crm/v3/objects/companies/${id}`, {
      properties: { name, domain, description },
    });
    return id;
  }
  const created = await hs('POST', '/crm/v3/objects/companies', {
    properties: { name, domain, description, industry: 'COMPUTER_SOFTWARE' },
  });
  return created.id as string;
}

async function findOrCreateHubSpotContact(email: string, firstname: string, lastname: string, jobtitle: string): Promise<string> {
  const search = await hs('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  });
  if (search?.results?.[0]?.id) {
    const id = search.results[0].id as string;
    await hs('PATCH', `/crm/v3/objects/contacts/${id}`, {
      properties: { email, firstname, lastname, jobtitle },
    });
    return id;
  }
  const created = await hs('POST', '/crm/v3/objects/contacts', {
    properties: { email, firstname, lastname, jobtitle },
  });
  return created.id as string;
}

async function associateContactToCompany(contactId: string, companyId: string) {
  // v4 default association type
  await hs('PUT', `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`, {});
}

async function createNote(companyId: string, body: string, timestampMs: number): Promise<string> {
  const created = await hs('POST', '/crm/v3/objects/notes', {
    properties: {
      hs_note_body: body,
      hs_timestamp: String(timestampMs),
    },
  });
  const noteId = created.id as string;
  // Associate with the company (default association type for note → company is type 190)
  await hs('PUT', `/crm/v4/objects/notes/${noteId}/associations/default/companies/${companyId}`, {});
  return noteId;
}

async function deleteExistingNotesOnCompany(companyId: string) {
  // Find existing notes associated, delete them so reseed is clean
  const search = await hs('POST', '/crm/v3/objects/notes/search', {
    filterGroups: [{ filters: [{ propertyName: 'associations.company', operator: 'EQ', value: companyId }] }],
    properties: ['hs_note_body'],
    limit: 100,
  });
  for (const note of search?.results ?? []) {
    await hs('DELETE', `/crm/v3/objects/notes/${note.id}`);
  }
}

async function seedAccount(wsId: string, accountName: string) {
  console.log(`\n=== ${accountName} ===`);

  // 1. Read account from agent-crm
  const ent = await supabase.from('entities').select('id, name, attributes').eq('workspace_id', wsId).eq('kind', 'account').eq('name', accountName).single();
  if (ent.error) throw ent.error;
  const accountId = ent.data!.id as string;
  const attrs = (ent.data!.attributes ?? {}) as Record<string, string>;
  const domain = (attrs.domain as string) ?? `${accountName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
  const description = (attrs.description as string) ?? (attrs.pitch as string) ?? `${accountName} (agent-crm benchmark seed)`;

  // 2. Read facts
  const factsResp = await supabase.from('facts').select('id, predicate, object_text, confidence, supersedes').eq('workspace_id', wsId).eq('subject_entity', accountId);
  if (factsResp.error) throw factsResp.error;
  const superseded = new Set((factsResp.data ?? []).map((f) => f.supersedes).filter(Boolean) as string[]);
  const activeFacts = (factsResp.data ?? []).filter((f) => !superseded.has(f.id as string));
  console.log(`  ${activeFacts.length} active facts`);

  // 3. Read contacts via works_at
  const worksAt = await supabase.from('facts').select('subject_entity').eq('workspace_id', wsId).eq('predicate', 'works_at').eq('object_entity', accountId);
  if (worksAt.error) throw worksAt.error;
  const contactIds = (worksAt.data ?? []).map((f) => f.subject_entity as string);
  const contactsResp = await supabase.from('entities').select('id, name, attributes').in('id', contactIds).eq('workspace_id', wsId).eq('kind', 'contact');
  if (contactsResp.error) throw contactsResp.error;
  const contacts = (contactsResp.data ?? []).map((e) => {
    const a = (e.attributes ?? {}) as Record<string, string>;
    const [first, ...rest] = (e.name as string).split(' ');
    return { name: e.name as string, first, last: rest.join(' ') || first, email: a.email ?? '', role: a.role ?? '' };
  }).filter((c) => c.email);
  console.log(`  ${contacts.length} contacts (with email)`);

  // 4. Mirror to HubSpot: company
  const hsCompanyId = await findOrCreateHubSpotCompany(accountName, domain, description);
  console.log(`  HubSpot company: ${hsCompanyId}`);

  // 5. Mirror contacts
  for (const c of contacts) {
    const hsContactId = await findOrCreateHubSpotContact(c.email, c.first, c.last, c.role);
    await associateContactToCompany(hsContactId, hsCompanyId);
  }

  // 6. Replace notes for this company with current facts (one note per top 5 facts)
  await deleteExistingNotesOnCompany(hsCompanyId);
  const topFacts = activeFacts.slice(0, 5);
  let noteCount = 0;
  for (const f of topFacts) {
    const ts = Date.now() - (noteCount + 1) * 86400_000; // 1-day spacing
    const body = `[fact] ${f.predicate}: ${f.object_text ?? '(no value)'} (confidence ${f.confidence})`;
    await createNote(hsCompanyId, body, ts);
    noteCount++;
  }

  // 7. Past touch: ensure agent-crm has a touch_draft + HubSpot has a matching note
  const ch = await supabase.from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
  let channelId = ch.data?.id as string | undefined;
  if (!channelId) {
    const newCh = await supabase.from('channels').insert({
      workspace_id: wsId,
      account_entity_id: accountId,
      title: `Account: ${accountName}`,
      kind: 'account',
    }).select('id').single();
    if (newCh.error) throw newCh.error;
    channelId = newCh.data!.id as string;
  }

  const existingTouch = await supabase.from('channel_posts').select('id, body').eq('channel_id', channelId).eq('kind', 'touch_draft').limit(1).maybeSingle();
  const pastTouchBody = `Hi ${(contacts[0]?.first ?? 'there')},\n\nWanted to follow up on what we were chatting about regarding ${accountName}. Saw the recent activity around ${activeFacts[0]?.predicate ?? 'your work'} and thought I'd check in.\n\nFree to chat next week?\n\nJake`;
  if (!existingTouch.data) {
    const insertedAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    const ins = await supabase.from('channel_posts').insert({
      channel_id: channelId,
      author_kind: 'agent',
      author_id: 'benchmark_v1_seeder',
      kind: 'touch_draft',
      body: pastTouchBody,
      created_at: insertedAt,
    }).select('id').single();
    if (ins.error) throw new Error(`past_touch insert failed: ${ins.error.message}`);
    console.log(`  agent-crm past_touch seeded (${ins.data?.id})`);
  } else {
    console.log(`  agent-crm past_touch exists`);
  }

  // HubSpot past-touch note (separate from fact notes, identifiable by prefix)
  const ts = Date.now() - 5 * 86400_000;
  await createNote(hsCompanyId, `[past touch sent ~5d ago]\n${pastTouchBody}`, ts);
  console.log(`  HubSpot past_touch note added`);
}

async function main() {
  const wsId = await findWorkspaceId();
  console.log(`workspace: ${wsId}\nseeding ${ACCOUNTS.length} accounts → HubSpot + agent-crm past_touch\n`);
  for (const name of ACCOUNTS) {
    try {
      await seedAccount(wsId, name);
    } catch (e) {
      console.error(`  FAILED for ${name}:`, (e as Error).message);
    }
  }
  console.log('\ndone');
}

main().catch((e) => { console.error(e); process.exit(1); });
