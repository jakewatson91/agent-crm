import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';
import { listConnectors } from '@agent-crm/inngest/functions/sources/registry_meta';
import { deriveDefaults } from '../_derive_defaults';
import { getUser } from '../../../_lib/auth';

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

// deriveDefaults lives in ../_derive_defaults so the Settings page can call
// it from /api/workspaces/regenerate without forking the prompt.

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }
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
    drafter: {
      pain_points: derived.pain_points,
      value_props: derived.value_props,
      tone_keywords: derived.tone_keywords,
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

  // First member of a new workspace is the creator, as owner.
  await supabase.from('workspace_members').insert({
    workspace_id, user_id: user.id, role: 'owner',
  });

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
    // registry_meta, not registry: only the cron default is needed here, and
    // the full registry's module graph (.js specifiers) breaks turbopack dev.
    const meta = listConnectors().find((m) => m.type === body.starter_source!.connector_type);
    if (meta) {
      const sr = await supabase.from('sources').insert({
        workspace_id,
        connector_type: body.starter_source.connector_type,
        name: body.starter_source.name,
        config: body.starter_source.config ?? {},
        schedule_cron: body.starter_source.schedule_cron ?? meta.schedule_cron,
      }).select('id').single();
      if (!sr.error && sr.data) source_id = sr.data.id as string;
    }
  }

  return NextResponse.json({ ok: true, workspace_id, source_id });
}
