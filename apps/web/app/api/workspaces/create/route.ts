import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
import { getConnector } from '@agent-crm/inngest/functions/sources/registry';

export const runtime = 'nodejs';

interface CreateReq {
  name: string;
  about: string;
  resend_api_key?: string;
  starter_source?: {
    connector_type: string;
    name: string;
    config: Record<string, unknown>;
    schedule_cron?: string;
  } | null;
}

// One-shot LLM derive: turn the plain-English "about" into the structured fields
// the agent loop expects. We keep the prompt vertical-neutral — no B2B SaaS
// assumptions — so a real-estate or recruiting workspace gets sensible defaults.
async function deriveDefaults(about: string): Promise<{
  icp: Record<string, unknown>;
  persona: Record<string, unknown>;
  constitution: string;
  knowledge_base: string;
  example_facts: Array<{ predicate: string; object_text: string }>;
}> {
  const sys = `You configure an agent-native CRM for a new customer. Read their plain-English description of what the agent should help with, then output JSON with five fields:

- "icp": object describing the kinds of accounts/things the agent should care about. Keys are open — pick what makes sense for this customer (industry, stage, location, size, signal_type, anything). Don't force B2B SaaS terms onto a non-SaaS use case.
- "persona": object with one or two keys describing how the agent represents the customer. Open keys; "pitch" or "voice" are common.
- "constitution": short free-form prose. Voice, do-nots, hard rules. Plain English, no jargon. 5-12 short lines.
- "knowledge_base": optional pain-to-angle mapping in the format described below; empty string if not applicable.
- "example_facts": array of 5-8 {predicate, object_text} pairs the enricher should look for when reading signals about an entity. These are EXAMPLES — choose predicate names + sample values appropriate for the customer's vertical. Real-estate workspace = list_price, days_on_market, etc. B2B sales = hiring_for, raised_round, etc. Don't reuse B2B examples on a non-B2B workspace.

KNOWLEDGE_BASE FORMAT (only if it fits the use case):
- TRIGGERS: <phrases the target audience might say>
  ANGLE: <which of their angles connects, 1 sentence>

Output strictly valid JSON: {"icp":{...},"persona":{...},"constitution":"...","knowledge_base":"...","example_facts":[{"predicate":"...","object_text":"..."}]}`;
  const user = `Customer description:\n${about}`;
  try {
    const r = await chatComplete({
      model: 'deepseek/deepseek-v4-flash:free',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });
    const j = JSON.parse(r.text);
    const examples = Array.isArray(j.example_facts)
      ? (j.example_facts as Array<{ predicate?: unknown; object_text?: unknown }>)
          .filter((f) => typeof f?.predicate === 'string' && typeof f?.object_text === 'string')
          .map((f) => ({ predicate: f.predicate as string, object_text: f.object_text as string }))
      : [];
    return {
      icp: (j.icp ?? {}) as Record<string, unknown>,
      persona: (j.persona ?? {}) as Record<string, unknown>,
      constitution: typeof j.constitution === 'string' ? j.constitution : '',
      knowledge_base: typeof j.knowledge_base === 'string' ? j.knowledge_base : '',
      example_facts: examples,
    };
  } catch {
    // Fall back to empty defaults so the wizard still finishes if the LLM hiccups.
    return { icp: {}, persona: {}, constitution: '', knowledge_base: '', example_facts: [] };
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CreateReq | null;
  if (!body?.name || !body?.about) {
    return NextResponse.json({ error: 'name and about required' }, { status: 400 });
  }

  const supabase = createServerClient();

  // create_workspace is logged as an event from a placeholder system actor.
  // The new workspace gets a fresh id from the RPC; the event row stores the
  // placeholder ws id (no projection consumes it for create_workspace).
  const systemActor = {
    workspace_id: '00000000-0000-0000-0000-000000000000',
    actor_kind: 'system' as const,
    actor_id: 'wizard',
  };

  const derived = await deriveDefaults(body.about);

  const policy: Record<string, unknown> = {
    outreach: {
      override_to: null,
      from_email: 'onboarding@resend.dev',
      banned_phrases: [],
      ...(body.resend_api_key ? { resend_api_key: body.resend_api_key } : {}),
    },
    enrichment: {
      contact_provider: 'none',
      example_facts: derived.example_facts,
    },
  };

  const created = await callTool(supabase, systemActor, 'create_workspace', {
    name: body.name,
    persona: derived.persona,
    icp: derived.icp,
    budget_cents: 1500,
    policy,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 500 });
  const workspace_id = created.target_id;

  // create_workspace doesn't yet take about/constitution/knowledge_base — they
  // live on the row but not in the tool schema. Update directly.
  await supabase.from('workspaces').update({
    about: body.about,
    constitution: derived.constitution,
    knowledge_base: derived.knowledge_base,
  }).eq('id', workspace_id);

  // Optional starter source.
  let source_id: string | null = null;
  if (body.starter_source?.connector_type && body.starter_source?.name) {
    const conn = getConnector(body.starter_source.connector_type);
    if (conn) {
      const sr = await supabase.from('sources').insert({
        workspace_id,
        connector_type: body.starter_source.connector_type,
        name: body.starter_source.name,
        config: body.starter_source.config ?? {},
        schedule_cron: body.starter_source.schedule_cron ?? conn.meta.schedule_cron,
      }).select('id').single();
      if (!sr.error && sr.data) source_id = sr.data.id as string;
    }
  }

  return NextResponse.json({ ok: true, workspace_id, source_id });
}
