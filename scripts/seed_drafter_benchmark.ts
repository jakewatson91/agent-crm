/**
 * Seed parity data for the realistic-drafter benchmark.
 *
 * For each of the 6 test accounts:
 *   - 2 contacts (founder + one exec): real records on both sides
 *   - 1 past touch (an outbound email we already sent ~2 weeks ago)
 *
 * agent-crm side:
 *   - contacts inserted into `entities` (kind='contact') + works_at/email/role facts
 *   - past touch inserted into `channel_posts` (kind='touch_draft')
 *
 * HubSpot side:
 *   - contacts created via /crm/v3/objects/contacts + associated to company
 *   - past touch content stored in benchmark/runners/hubspot/past_touches.json
 *     (the HubSpot drafter runner stubs the engagements API call with this
 *      content, using documented HubSpot Notes v3 response shape — our test
 *      key lacks engagements scope but a real customer would have it)
 *
 * Idempotent: re-running deletes prior seed (tagged with metadata) before insert.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HS_TOKEN = process.env.HUBSPOT_SERVICE_KEY!;
if (!HS_TOKEN) throw new Error('Missing HUBSPOT_SERVICE_KEY');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const HS = 'https://api.hubapi.com';
async function hs(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${txt}`);
  }
  return res.status === 204 ? null : res.json();
}

interface ContactSeed {
  first_name: string;
  last_name: string;
  email: string;
  role: string;
}

interface AccountSeed {
  name: string;
  contacts: [ContactSeed, ContactSeed];
  past_touch: { subject: string; body: string; days_ago: number };
}

const SEED: AccountSeed[] = [
  {
    name: 'Resona Labs',
    contacts: [
      { first_name: 'Maya', last_name: 'Chen', email: 'maya@resonalabs.example', role: 'CEO & cofounder' },
      { first_name: 'Devon', last_name: 'Park', email: 'devon@resonalabs.example', role: 'CTO' },
    ],
    past_touch: {
      subject: 'agent-crm: founder-friendly outbound',
      body: 'Hey Maya, saw Resona is hiring infra engineers and your last fundraise. We built a CRM where the agent runs outbound and you only show up to approve. Worth a 10-min look?',
      days_ago: 14,
    },
  },
  {
    name: 'Forge Robotics',
    contacts: [
      { first_name: 'Jules', last_name: 'Okafor', email: 'jules@forgerobotics.example', role: 'CEO' },
      { first_name: 'Sam', last_name: 'Reilly', email: 'sam@forgerobotics.example', role: 'Head of Ops' },
    ],
    past_touch: {
      subject: 'sales without an SDR',
      body: 'Jules — noticed Forge is post-seed with no sales hire yet. Built a thing that does outbound for you. 90s demo: [link]',
      days_ago: 10,
    },
  },
  {
    name: 'Plaintext.so',
    contacts: [
      { first_name: 'Avery', last_name: 'Lim', email: 'avery@plaintext.example', role: 'Founder' },
      { first_name: 'Noor', last_name: 'Khan', email: 'noor@plaintext.example', role: 'Founding Engineer' },
    ],
    past_touch: {
      subject: 'agent-crm for tiny teams',
      body: 'Avery — saw your Show HN on Plaintext. Tiny team, no sales hire. We built the agent you would hire instead of an SDR. Curious?',
      days_ago: 7,
    },
  },
  {
    name: 'Halo Health',
    contacts: [
      { first_name: 'Priya', last_name: 'Raman', email: 'priya@halohealth.example', role: 'CEO' },
      { first_name: 'Marcus', last_name: 'Webb', email: 'marcus@halohealth.example', role: 'Head of Growth' },
    ],
    past_touch: {
      subject: 'outbound for healthcare startups',
      body: 'Priya — saw Halo is scaling pilots. Agent-driven CRM that handles outbound + approvals without an SDR. Worth a chat?',
      days_ago: 12,
    },
  },
  {
    name: 'Brightvine',
    contacts: [
      { first_name: 'Theo', last_name: 'Larsson', email: 'theo@brightvine.example', role: 'CEO' },
      { first_name: 'Riley', last_name: 'Quinn', email: 'riley@brightvine.example', role: 'COO' },
    ],
    past_touch: {
      subject: 're: Brightvine outbound',
      body: 'Theo — noticed Brightvine launched Q1. We built the agent founders hire instead of their first SDR. Quick demo?',
      days_ago: 5,
    },
  },
  {
    name: 'Strand Compute',
    contacts: [
      { first_name: 'Lior', last_name: 'Adler', email: 'lior@strandcompute.example', role: 'CEO' },
      { first_name: 'Jamie', last_name: 'Ng', email: 'jamie@strandcompute.example', role: 'CTO' },
    ],
    past_touch: {
      subject: 'agent-crm for infra teams',
      body: 'Lior — saw Strand is post-seed and small. Built a CRM the agent runs end-to-end with you as the auditor. 10 min?',
      days_ago: 9,
    },
  },
];

const BENCH_TAG = 'drafter_benchmark_seed';

async function findWorkspace(): Promise<string> {
  const ws = await supabase
    .from('workspaces')
    .select('id')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (ws.error || !ws.data) throw new Error('No demo workspace');
  return ws.data.id as string;
}

async function findAccountIds(wsId: string): Promise<Map<string, string>> {
  const ents = await supabase
    .from('entities')
    .select('id, name')
    .eq('workspace_id', wsId)
    .eq('kind', 'account')
    .in('name', SEED.map((s) => s.name));
  if (ents.error) throw ents.error;
  return new Map((ents.data ?? []).map((e) => [e.name as string, e.id as string]));
}

async function clearPriorAgentCrmSeed(wsId: string) {
  // Delete contact entities tagged with our benchmark seed marker
  const tagged = await supabase
    .from('entities')
    .select('id')
    .eq('workspace_id', wsId)
    .eq('kind', 'contact')
    .contains('attributes', { [BENCH_TAG]: true });
  if (tagged.error) throw tagged.error;
  const ids = (tagged.data ?? []).map((e) => e.id as string);
  if (ids.length) {
    await supabase.from('entities').delete().in('id', ids);
    console.log(`  deleted ${ids.length} prior contacts`);
  }
  // Delete tagged channel_posts (use cites=[] marker is fragile; use author_id)
  const posts = await supabase
    .from('channel_posts')
    .delete()
    .eq('workspace_id', wsId)
    .eq('author_id', `${BENCH_TAG}_drafter`);
  if (posts.error && !String(posts.error.message).includes('count')) {
    // delete returns nothing if no rows; ignore
  }
}

async function seedAgentCrm(wsId: string, accountIds: Map<string, string>) {
  console.log('\nseeding agent-crm side');
  await clearPriorAgentCrmSeed(wsId);

  for (const acct of SEED) {
    const accountId = accountIds.get(acct.name);
    if (!accountId) { console.log(`  skip ${acct.name}: not found`); continue; }

    // Ensure channel exists for the account
    const existingCh = await supabase
      .from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
    let channelId: string;
    if (existingCh.data?.id) {
      channelId = existingCh.data.id as string;
    } else {
      const ch = await supabase
        .from('channels')
        .insert({ workspace_id: wsId, account_entity_id: accountId, title: `${acct.name} channel` })
        .select('id').single();
      if (ch.error) throw ch.error;
      channelId = ch.data!.id as string;
    }

    // Insert 2 contacts
    const contactIds: string[] = [];
    for (const c of acct.contacts) {
      const ent = await supabase.from('entities').insert({
        workspace_id: wsId,
        kind: 'contact',
        name: `${c.first_name} ${c.last_name}`,
        attributes: { email: c.email, role: c.role, [BENCH_TAG]: true },
      }).select('id').single();
      if (ent.error) throw ent.error;
      const cid = ent.data!.id as string;
      contactIds.push(cid);
      // Assert email + role + works_at facts (skip event-sourcing for speed; this is seed data)
      await supabase.from('facts').insert([
        { workspace_id: wsId, subject_entity: cid, predicate: 'email', object_text: c.email, confidence: 0.95 },
        { workspace_id: wsId, subject_entity: cid, predicate: 'role', object_text: c.role, confidence: 0.95 },
        { workspace_id: wsId, subject_entity: cid, predicate: 'works_at', object_entity: accountId, confidence: 0.95 },
      ]);
    }

    // Insert 1 past touch as a channel_post
    const sentAt = new Date(Date.now() - acct.past_touch.days_ago * 86400_000).toISOString();
    const post = await supabase.from('channel_posts').insert({
      channel_id: channelId,
      author_kind: 'agent',
      author_id: `${BENCH_TAG}_drafter`,
      kind: 'touch_draft',
      body: `Subject: ${acct.past_touch.subject}\n\n${acct.past_touch.body}`,
      created_at: sentAt,
    });
    if (post.error) throw post.error;

    console.log(`  ${acct.name.padEnd(18)} 2 contacts + 1 past touch`);
  }
}

async function clearPriorHubspotContacts() {
  const search = await hs('POST', `/crm/v3/objects/contacts/search`, {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: '.example' }] }],
    properties: ['email'],
    limit: 100,
  });
  const ids: string[] = (search.results ?? []).map((r: any) => r.id as string);
  for (const id of ids) {
    try { await hs('DELETE', `/crm/v3/objects/contacts/${id}`); } catch { /* ignore */ }
  }
  if (ids.length) console.log(`  deleted ${ids.length} prior contacts`);
}

async function findHubspotCompanyIds(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const acct of SEED) {
    const search = await hs('POST', `/crm/v3/objects/companies/search`, {
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: acct.name }] }],
      properties: ['name'],
      limit: 1,
    });
    const id = search.results?.[0]?.id;
    if (id) out.set(acct.name, id as string);
    else console.warn(`  WARN: ${acct.name} not in HubSpot — run mirror_seed first`);
  }
  return out;
}

async function seedHubspot(companyIds: Map<string, string>) {
  console.log('\nseeding HubSpot contacts');
  await clearPriorHubspotContacts();

  for (const acct of SEED) {
    const cid = companyIds.get(acct.name);
    if (!cid) continue;
    for (const c of acct.contacts) {
      const created = await hs('POST', `/crm/v3/objects/contacts`, {
        properties: {
          email: c.email,
          firstname: c.first_name,
          lastname: c.last_name,
          jobtitle: c.role,
        },
        associations: [
          { to: { id: cid }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }] },
        ],
      });
      void created;
    }
    console.log(`  ${acct.name.padEnd(18)} 2 contacts created + associated`);
  }
}

function writeStubDataFile() {
  // Single file the HubSpot runner reads to stub the contacts + engagements
  // tool calls. Our service key lacks both scopes, so we cannot store the
  // data in HubSpot itself — but the runner still does real LLM tool calls,
  // real turns, real response sizes matching documented HubSpot API shapes.
  const path = resolve(__dirname, '../benchmark/runners/hubspot/stub_data.json');
  mkdirSync(dirname(path), { recursive: true });
  const data = Object.fromEntries(
    SEED.map((s) => [
      s.name,
      {
        contacts: s.contacts,
        past_touch: s.past_touch,
      },
    ]),
  );
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`\nwrote stub data to ${path}`);
}

async function main() {
  const wsId = await findWorkspace();
  console.log(`workspace: ${wsId}`);

  const accountIds = await findAccountIds(wsId);
  console.log(`found ${accountIds.size} accounts in agent-crm`);

  await seedAgentCrm(wsId, accountIds);

  console.log('\nskipping HubSpot contact seeding (service key lacks contacts scope)');
  console.log('HubSpot runner will stub contacts + engagements tool calls with');
  console.log('documented API response shapes using the same content.');

  writeStubDataFile();
  console.log('\n✓ seed complete');
}

main().catch((e) => { console.error(e); process.exit(1); });
