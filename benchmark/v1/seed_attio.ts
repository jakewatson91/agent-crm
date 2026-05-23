/**
 * Attio seeder. Mirrors the 6 benchmark accounts (companies + people +
 * fact-as-notes + past-touch note) into the Attio workspace tied to
 * ATTIO_API_KEY in .env.local.
 *
 * Idempotent: searches by name/email first, updates if found, creates if not.
 * Deletes existing notes on each company before re-seeding the fact notes.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];

const ATTIO_KEY = process.env.ATTIO_API_KEY!;
if (!ATTIO_KEY) throw new Error('Missing ATTIO_API_KEY');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const BASE = 'https://api.attio.com';

async function attio(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ATTIO_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Attio ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204 || res.status === 404) return null;
  return res.json();
}

async function findCompanyByName(name: string): Promise<string | null> {
  const r = await attio('POST', '/v2/objects/companies/records/query', {
    filter: { name: { $contains: name } },
    limit: 5,
  });
  const exact = (r.data ?? []).find((c: any) =>
    (c.values?.name?.[0]?.value ?? '').toLowerCase() === name.toLowerCase(),
  );
  return exact?.id?.record_id ?? null;
}

async function upsertCompany(name: string, domain: string, description: string): Promise<string> {
  const existing = await findCompanyByName(name);
  const values = {
    name: [{ value: name }],
    domains: [{ domain }],
    description: [{ value: description }],
  };
  if (existing) {
    await attio('PATCH', `/v2/objects/companies/records/${existing}`, { data: { values } });
    return existing;
  }
  const created = await attio('POST', '/v2/objects/companies/records', { data: { values } });
  return created.data.id.record_id as string;
}

async function findPersonByEmail(email: string): Promise<string | null> {
  const r = await attio('POST', '/v2/objects/people/records/query', {
    filter: { email_addresses: { email_address: email } },
    limit: 1,
  });
  return r.data?.[0]?.id?.record_id ?? null;
}

async function upsertPerson(email: string, first: string, last: string, jobTitle: string, companyRecordId: string): Promise<string> {
  const existing = await findPersonByEmail(email);
  const values = {
    name: [{ first_name: first, last_name: last, full_name: `${first} ${last}`.trim() }],
    email_addresses: [{ email_address: email }],
    job_title: [{ value: jobTitle }],
    company: [{ target_object: 'companies', target_record_id: companyRecordId }],
  };
  if (existing) {
    await attio('PATCH', `/v2/objects/people/records/${existing}`, { data: { values } });
    return existing;
  }
  const created = await attio('POST', '/v2/objects/people/records', { data: { values } });
  return created.data.id.record_id as string;
}

async function deleteNotesOnCompany(companyRecordId: string) {
  const r = await attio('GET', `/v2/notes?parent_object=companies&parent_record_id=${companyRecordId}&limit=50`);
  for (const n of r?.data ?? []) {
    await attio('DELETE', `/v2/notes/${n.id.note_id}`);
  }
}

async function createNote(companyRecordId: string, title: string, body: string): Promise<string> {
  const r = await attio('POST', '/v2/notes', {
    data: {
      parent_object: 'companies',
      parent_record_id: companyRecordId,
      title,
      content: body,
      format: 'plaintext',
    },
  });
  return r.data.id.note_id as string;
}

async function findWorkspaceId(): Promise<string> {
  const ws = await supabase.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw ws.error ?? new Error('workspace not found');
  return ws.data.id as string;
}

async function seedAccount(wsId: string, accountName: string) {
  console.log(`\n=== ${accountName} ===`);

  const ent = await supabase.from('entities').select('id, name, attributes').eq('workspace_id', wsId).eq('kind', 'account').eq('name', accountName).single();
  if (ent.error) throw ent.error;
  const accountId = ent.data!.id as string;
  const attrs = (ent.data!.attributes ?? {}) as Record<string, string>;
  const domain = attrs.domain ?? `${accountName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
  const description = attrs.description ?? attrs.pitch ?? `${accountName} (agent-crm benchmark seed)`;

  const factsResp = await supabase.from('facts').select('id, predicate, object_text, confidence, supersedes').eq('workspace_id', wsId).eq('subject_entity', accountId);
  if (factsResp.error) throw factsResp.error;
  const superseded = new Set((factsResp.data ?? []).map((f) => f.supersedes).filter(Boolean) as string[]);
  const activeFacts = (factsResp.data ?? []).filter((f) => !superseded.has(f.id as string));

  const worksAt = await supabase.from('facts').select('subject_entity').eq('workspace_id', wsId).eq('predicate', 'works_at').eq('object_entity', accountId);
  if (worksAt.error) throw worksAt.error;
  const contactIds = (worksAt.data ?? []).map((f) => f.subject_entity as string);
  const contactsResp = await supabase.from('entities').select('id, name, attributes').in('id', contactIds).eq('workspace_id', wsId).eq('kind', 'contact');
  if (contactsResp.error) throw contactsResp.error;
  const contacts = (contactsResp.data ?? []).map((e) => {
    const a = (e.attributes ?? {}) as Record<string, string>;
    const [first, ...rest] = (e.name as string).split(' ');
    return { first, last: rest.join(' ') || first, email: a.email ?? '', role: a.role ?? '' };
  }).filter((c) => c.email);

  console.log(`  ${activeFacts.length} facts, ${contacts.length} contacts`);

  const companyId = await upsertCompany(accountName, domain, description);
  console.log(`  Attio company: ${companyId}`);

  for (const c of contacts) {
    await upsertPerson(c.email, c.first, c.last, c.role, companyId);
  }

  await deleteNotesOnCompany(companyId);
  for (const f of activeFacts.slice(0, 5)) {
    const body = `[fact] ${f.predicate}: ${f.object_text ?? '(no value)'} (confidence ${f.confidence})`;
    await createNote(companyId, `Fact: ${f.predicate}`, body);
  }

  // Past touch (mirror what we did for HubSpot)
  const ch = await supabase.from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
  if (ch.data?.id) {
    const posts = await supabase.from('channel_posts').select('id, body').eq('channel_id', ch.data.id).eq('kind', 'touch_draft').order('created_at', { ascending: false }).limit(1);
    const p = posts.data?.[0];
    if (p) {
      await createNote(companyId, 'Past touch (~5d ago)', `[past touch sent ~5d ago]\n${p.body}`);
    }
  }

  console.log(`  done`);
}

async function main() {
  const wsId = await findWorkspaceId();
  console.log(`workspace: ${wsId}\nseeding ${ACCOUNTS.length} accounts into Attio\n`);
  for (const name of ACCOUNTS) {
    try { await seedAccount(wsId, name); }
    catch (e) { console.error(`  FAILED for ${name}:`, (e as Error).message); }
  }
  console.log('\ndone');
}

main().catch((e) => { console.error(e); process.exit(1); });
