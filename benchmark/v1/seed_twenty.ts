/**
 * Twenty CRM seeder. Mirrors the 6 benchmark accounts (company + people +
 * fact-as-note + past-touch note) into a self-hosted Twenty instance at
 * TWENTY_BASE_URL (default http://localhost:3001) using TWENTY_API_KEY.
 *
 * Idempotent: searches by name/email first via REST, updates if found, creates
 * if not. Deletes existing notes per company before re-seeding fact notes.
 *
 * Twenty's REST API uses /rest/{object} for the data plane. Default standard
 * objects are company, person, note. Schema is per-workspace customizable so
 * field names below match the fresh-install defaults.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const ACCOUNTS = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium'];

const TWENTY_BASE = process.env.TWENTY_BASE_URL ?? 'http://localhost:3001';
const TWENTY_KEY = process.env.TWENTY_API_KEY!;
if (!TWENTY_KEY) throw new Error('Missing TWENTY_API_KEY');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function twenty(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${TWENTY_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TWENTY_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Twenty ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204 || res.status === 404) return null;
  return res.json();
}

async function findCompanyByName(name: string): Promise<string | null> {
  const r = await twenty('GET', `/rest/companies?filter=name[eq]:${encodeURIComponent(`"${name}"`)}&limit=1`);
  return r?.data?.companies?.[0]?.id ?? null;
}

async function upsertCompany(name: string, domain: string): Promise<string> {
  const existing = await findCompanyByName(name);
  const data = {
    name,
    domainName: { primaryLinkUrl: `https://${domain}`, primaryLinkLabel: domain, secondaryLinks: [] },
  };
  if (existing) {
    await twenty('PATCH', `/rest/companies/${existing}`, data);
    return existing;
  }
  const created = await twenty('POST', '/rest/companies', data);
  return created.data.createCompany.id as string;
}

async function findPersonByEmail(email: string): Promise<string | null> {
  const r = await twenty('GET', `/rest/people?filter=emails.primaryEmail[eq]:${encodeURIComponent(`"${email}"`)}&limit=1`);
  return r?.data?.people?.[0]?.id ?? null;
}

async function upsertPerson(email: string, first: string, last: string, jobTitle: string, targetCompanyId: string): Promise<string> {
  const existing = await findPersonByEmail(email);
  const data = {
    name: { firstName: first, lastName: last },
    emails: { primaryEmail: email, additionalEmails: [] },
    jobTitle,
    companyId: targetCompanyId,
  };
  if (existing) {
    await twenty('PATCH', `/rest/people/${existing}`, data);
    return existing;
  }
  const created = await twenty('POST', '/rest/people', data);
  return created.data.createPerson.id as string;
}

async function deleteCompanyNotes(targetCompanyId: string) {
  // Notes link via noteTargets relationship table. Easiest: list notes attached to this company, delete each.
  const r = await twenty('GET', `/rest/noteTargets?filter=targetCompanyId[eq]:${targetCompanyId}&limit=100`);
  const targets = r?.data?.noteTargets ?? [];
  for (const t of targets) {
    if (t.noteId) await twenty('DELETE', `/rest/notes/${t.noteId}`);
  }
}

async function createNote(targetCompanyId: string, title: string, body: string): Promise<string> {
  const noteResp = await twenty('POST', '/rest/notes', { title, bodyV2: { markdown: body, blocknote: '' } });
  const noteId = noteResp.data.createNote.id as string;
  await twenty('POST', '/rest/noteTargets', { noteId, targetCompanyId });
  return noteId;
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

  const targetCompanyId = await upsertCompany(accountName, domain);
  console.log(`  Twenty company: ${targetCompanyId}`);

  for (const c of contacts) await upsertPerson(c.email, c.first, c.last, c.role, targetCompanyId);

  await deleteCompanyNotes(targetCompanyId);
  for (const f of activeFacts.slice(0, 5)) {
    await createNote(targetCompanyId, `Fact: ${f.predicate}`, `[fact] ${f.predicate}: ${f.object_text ?? '(no value)'} (confidence ${f.confidence})`);
  }

  // Past touch
  const ch = await supabase.from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
  if (ch.data?.id) {
    const posts = await supabase.from('channel_posts').select('id, body').eq('channel_id', ch.data.id).eq('kind', 'touch_draft').order('created_at', { ascending: false }).limit(1);
    const p = posts.data?.[0];
    if (p) await createNote(targetCompanyId, 'Past touch (~5d ago)', `[past touch sent ~5d ago]\n${p.body}`);
  }

  console.log(`  done`);
}

async function main() {
  const wsId = await findWorkspaceId();
  console.log(`workspace: ${wsId}, twenty: ${TWENTY_BASE}\nseeding ${ACCOUNTS.length} accounts into Twenty\n`);
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const name = ACCOUNTS[i];
    try { await seedAccount(wsId, name); }
    catch (e) { console.error(`  FAILED for ${name}:`, (e as Error).message); }
    // Twenty's rate limit is 100 calls per 60s. Each account uses 10-15 calls. Wait between accounts.
    if (i < ACCOUNTS.length - 1) {
      console.log(`  ... waiting 65s for rate-limit window to clear ...`);
      await new Promise((r) => setTimeout(r, 65_000));
    }
  }
  console.log('\ndone');
}

main().catch((e) => { console.error(e); process.exit(1); });
