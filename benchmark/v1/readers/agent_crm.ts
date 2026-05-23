/**
 * agent-crm side projection reader for v1 benchmark.
 *
 * Builds the projection in batched Supabase reads, returns it as a structured
 * object plus the raw Supabase responses for receipt auditing.
 *
 * Mirrors the projection shape used by benchmark/runners/agent-crm/run_drafter.ts
 * but exposes the raw responses so v1 receipts can show exactly what each
 * Supabase call returned.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface Projection {
  account: { id: string; name: string; attributes: Record<string, unknown> };
  facts: Array<{ id: string; predicate: string; object: string | null; confidence: number }>;
  contacts: Array<{ id: string; name: string; email: string; role: string }>;
  past_touch: { id: string; body: string; days_ago: number } | null;
  signals: Array<{ id: string; type: string; magnitude: number; body: string; observed_at: string }>;
}

export interface AgentCrmReadResult {
  projection: Projection;
  raw_supabase_responses: Record<string, unknown>;
  api_calls: number;
  latency_ms: number;
}

let _sb: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_sb) return _sb;
  _sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  return _sb;
}

let _workspaceId: string | null = null;
export async function getWorkspaceId(): Promise<string> {
  if (_workspaceId) return _workspaceId;
  const ws = await sb()
    .from('workspaces').select('id, name').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error(`workspace not found: ${ws.error?.message}`);
  _workspaceId = ws.data.id as string;
  return _workspaceId;
}

export async function readProjection(accountName: string): Promise<AgentCrmReadResult> {
  const wsId = await getWorkspaceId();
  const t0 = Date.now();
  const raw: Record<string, unknown> = {};
  let calls = 0;

  // 1. Account entity
  const ent = await sb()
    .from('entities').select('id, name, attributes')
    .eq('workspace_id', wsId).eq('kind', 'account').eq('name', accountName).single();
  calls++;
  raw.account_entity = ent;
  if (ent.error || !ent.data) throw new Error(`account not found: ${accountName} (${ent.error?.message})`);
  const accountId = ent.data.id as string;

  // 2. Facts on the account, with supersede dedup
  const allFacts = await sb()
    .from('facts').select('id, predicate, object_text, confidence, supersedes')
    .eq('workspace_id', wsId).eq('subject_entity', accountId);
  calls++;
  raw.facts_on_account = allFacts;
  if (allFacts.error) throw allFacts.error;
  const supersededIds = new Set(
    (allFacts.data ?? [])
      .map((f) => f.supersedes as string | null)
      .filter((x): x is string => !!x),
  );
  const activeFacts = (allFacts.data ?? []).filter((f) => !supersededIds.has(f.id as string));

  // 3. works_at facts pointing at this account -> contact ids
  const worksAt = await sb()
    .from('facts').select('subject_entity')
    .eq('workspace_id', wsId).eq('predicate', 'works_at').eq('object_entity', accountId);
  calls++;
  raw.works_at_facts = worksAt;
  if (worksAt.error) throw worksAt.error;
  const contactIds = (worksAt.data ?? []).map((f) => f.subject_entity as string);

  // 4. Contact entities
  let contacts: Projection['contacts'] = [];
  if (contactIds.length) {
    const ents = await sb()
      .from('entities').select('id, name, attributes')
      .in('id', contactIds).eq('workspace_id', wsId).eq('kind', 'contact');
    calls++;
    raw.contact_entities = ents;
    if (ents.error) throw ents.error;
    contacts = (ents.data ?? []).map((e) => {
      const attrs = (e.attributes ?? {}) as Record<string, string>;
      return {
        id: e.id as string,
        name: e.name as string,
        email: attrs.email ?? '',
        role: attrs.role ?? '',
      };
    });
  }

  // 5. Past touch (most recent touch_draft on account's channel)
  const ch = await sb()
    .from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', accountId).maybeSingle();
  calls++;
  raw.channel = ch;
  let past_touch: Projection['past_touch'] = null;
  if (ch.data?.id) {
    const posts = await sb()
      .from('channel_posts').select('id, body, created_at')
      .eq('channel_id', ch.data.id).eq('kind', 'touch_draft')
      .order('created_at', { ascending: false }).limit(1);
    calls++;
    raw.past_touch_post = posts;
    if (posts.error) throw posts.error;
    const p = posts.data?.[0];
    if (p) {
      const daysAgo = Math.round((Date.now() - new Date(p.created_at as string).getTime()) / 86400_000);
      past_touch = { id: `touch_${p.id}`, body: p.body as string, days_ago: daysAgo };
    }
  }

  // 6. Recent signals
  const sigs = await sb()
    .from('signals').select('id, type, magnitude, body_for_embedding, observed_at')
    .eq('workspace_id', wsId).eq('entity_id', accountId)
    .order('observed_at', { ascending: false }).limit(5);
  calls++;
  raw.signals = sigs;
  if (sigs.error) throw sigs.error;

  const projection: Projection = {
    account: { id: accountId, name: ent.data.name as string, attributes: ent.data.attributes as Record<string, unknown> },
    facts: activeFacts.map((f) => ({
      id: f.id as string,
      predicate: f.predicate as string,
      object: (f.object_text as string | null) ?? null,
      confidence: f.confidence as number,
    })),
    contacts,
    past_touch,
    signals: (sigs.data ?? []).map((s) => ({
      id: s.id as string,
      type: s.type as string,
      magnitude: s.magnitude as number,
      body: (s.body_for_embedding as string | null) ?? '',
      observed_at: s.observed_at as string,
    })),
  };

  return {
    projection,
    raw_supabase_responses: raw,
    api_calls: calls,
    latency_ms: Date.now() - t0,
  };
}
