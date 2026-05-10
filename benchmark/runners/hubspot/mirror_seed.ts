/**
 * Mirrors the agent-crm demo seed (6 accounts + facts + signals) into the
 * HubSpot test account so the head-to-head benchmark uses equivalent data.
 *
 * Service-key scope catalog excludes notes/engagements, so we store fact and
 * signal data as multi-line text custom properties on the Company. This is
 * actually a *stronger* HubSpot baseline than notes: a single GET on the
 * company fetches everything, no pagination, no association lookups.
 *
 * Schema mapping:
 *   account     -> Company
 *                  + standard properties: name, domain, industry, description (= pitch)
 *                  + custom property `stack`         (text, comma-separated)
 *                  + custom property `agent_facts`   (multiline text, line per fact)
 *                  + custom property `agent_signals` (multiline text, line per signal)
 *                  + custom property `agent_crm_seed` (text "true", for idempotent cleanup)
 *
 * Usage:
 *   pnpm exec tsx benchmark/runners/hubspot/mirror_seed.ts
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { createClient } from '@supabase/supabase-js';

const HS_TOKEN = process.env.HUBSPOT_SERVICE_KEY!;
if (!HS_TOKEN) throw new Error('Missing HUBSPOT_SERVICE_KEY');

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

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const SEED_TAG = 'agent_crm_seed';

const CUSTOM_PROPS: Array<{ name: string; label: string; fieldType: 'text' | 'textarea' }> = [
  { name: 'stack',          label: 'Tech Stack',     fieldType: 'text' },
  { name: 'agent_facts',    label: 'Agent Facts',    fieldType: 'textarea' },
  { name: 'agent_signals',  label: 'Agent Signals',  fieldType: 'textarea' },
  { name: SEED_TAG,         label: 'Agent CRM Seed', fieldType: 'text' },
];

async function ensureCustomProperties() {
  for (const p of CUSTOM_PROPS) {
    try {
      await hs('GET', `/crm/v3/properties/companies/${p.name}`);
      console.log(`  ✓ ${p.name} exists`);
    } catch {
      await hs('POST', `/crm/v3/properties/companies`, {
        name: p.name,
        label: p.label,
        type: 'string',
        fieldType: p.fieldType,
        groupName: 'companyinformation',
      });
      console.log(`  ✓ created ${p.name}`);
    }
  }
}

async function deletePriorSeed() {
  const search = await hs('POST', `/crm/v3/objects/companies/search`, {
    filterGroups: [{ filters: [{ propertyName: SEED_TAG, operator: 'HAS_PROPERTY' }] }],
    properties: ['name'],
    limit: 100,
  });
  const ids: string[] = (search.results ?? []).map((r: any) => r.id as string);
  if (ids.length === 0) {
    console.log('  (no prior seed to delete)');
    return;
  }
  for (const id of ids) {
    await hs('DELETE', `/crm/v3/objects/companies/${id}`);
  }
  console.log(`  deleted ${ids.length} prior companies`);
}

async function main() {
  console.log('mirroring agent-crm demo into HubSpot…\n');

  console.log('1. ensure custom properties');
  await ensureCustomProperties();

  console.log('\n2. clear prior seed');
  await deletePriorSeed();

  console.log('\n3. find demo workspace in agent-crm');
  const ws = await supabase
    .from('workspaces')
    .select('id, name, created_at')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (ws.error || !ws.data) throw new Error('No demo workspace; run `pnpm seed` first.');
  const WS = ws.data.id as string;
  console.log(`   workspace ${WS}`);

  const accounts = await supabase
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', WS)
    .eq('kind', 'account');
  if (accounts.error) throw accounts.error;

  console.log(`\n4. mirror ${accounts.data!.length} companies\n`);

  for (const a of accounts.data!) {
    const attrs = (a.attributes ?? {}) as Record<string, any>;

    // "Active" facts = not pointed-to by another fact's supersedes column.
    // (A fact's own supersedes is null OR points to something — that doesn't
    //  determine active status. What matters is whether anything supersedes it.)
    const allFacts = await supabase
      .from('facts')
      .select('id, predicate, object_text, confidence, supersedes')
      .eq('subject_entity', a.id);
    if (allFacts.error) throw allFacts.error;
    const supersededIds = new Set(
      (allFacts.data ?? []).map((f) => f.supersedes).filter((x): x is string => !!x),
    );
    const factRes = {
      error: null,
      data: (allFacts.data ?? []).filter((f) => !supersededIds.has(f.id as string)),
    };

    const sigRes = await supabase
      .from('signals')
      .select('id, type, magnitude, body_for_embedding, observed_at')
      .eq('entity_id', a.id);
    if (sigRes.error) throw sigRes.error;

    // Render facts and signals as multiline text — what a competent ops team
    // would actually paste into a custom property given no notes access.
    const factsText = (factRes.data ?? [])
      .map((f) => `[${f.predicate}] ${f.object_text ?? ''} (confidence=${f.confidence}, fact_id=${f.id})`)
      .join('\n');

    const signalsText = (sigRes.data ?? [])
      .map((s) => `[${s.type} mag=${s.magnitude} at=${s.observed_at}] ${s.body_for_embedding ?? ''} (signal_id=${s.id})`)
      .join('\n');

    // Prepend industry to agent_facts since HubSpot's `industry` field is a fixed enum
    // that doesn't accept values like `b2b_saas`. The agent reads agent_facts anyway.
    const factsTextWithIndustry = `[industry] ${attrs.industry ?? ''}\n${factsText}`;

    const company = await hs('POST', `/crm/v3/objects/companies`, {
      properties: {
        name: a.name,
        domain: attrs.domain ?? `${(a.name as string).toLowerCase().replace(/[^a-z]+/g, '')}.example`,
        description: attrs.pitch ?? '',
        stack: Array.isArray(attrs.stack) ? attrs.stack.join(',') : '',
        agent_facts: factsTextWithIndustry,
        agent_signals: signalsText,
        [SEED_TAG]: 'true',
      },
    });

    console.log(`  ${(a.name as string).padEnd(18)} -> company ${company.id} (${factRes.data?.length ?? 0} facts, ${sigRes.data?.length ?? 0} signals)`);
  }

  console.log('\n✓ mirror complete');
}

main().catch((e) => { console.error(e); process.exit(1); });
