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

// Streams one JSON line per step so the wizard can show real progress instead
// of a dead "creating…" button — the slow part (deriveDefaults) is one LLM
// call that can take several seconds with nothing else for the user to look
// at otherwise. Client reads this as newline-delimited JSON; step keys are
// looked up against a label map on the client so wording lives in one place.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) {
    return new Response(JSON.stringify({ step: 'error', error: 'not signed in' }) + '\n', { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as CreateReq | null;
  if (!body?.name || !body?.about) {
    return new Response(JSON.stringify({ step: 'error', error: 'name and about required' }) + '\n', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      try {
        const supabase = createServerClient();

        // create_workspace is logged as an event from a placeholder system actor.
        // The new workspace gets a fresh id from the RPC; the event row stores
        // the placeholder ws id (no projection consumes it for create_workspace).
        const systemActor = {
          workspace_id: '00000000-0000-0000-0000-000000000000',
          actor_kind: 'system' as const,
          actor_id: 'wizard',
        };

        emit({ step: 'deriving' });
        const derived = await deriveDefaults(body.about);
        emit({ step: 'derived' });

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

        emit({ step: 'workspace' });
        const created = await callTool(supabase, systemActor, 'create_workspace', {
          name: body.name,
          persona: derived.persona,
          icp: derived.icp,
          budget_cents: 1500,
          policy,
        });
        if (!created.ok) { emit({ step: 'error', error: created.error }); controller.close(); return; }
        const workspace_id = created.target_id;

        // First member of a new workspace is the creator, as owner.
        await supabase.from('workspace_members').insert({
          workspace_id, user_id: user.id, role: 'owner',
        });

        // create_workspace doesn't yet take about/constitution/knowledge_base —
        // they live on the row but not in the tool schema. Update directly.
        await supabase.from('workspaces').update({
          about: body.about,
          constitution: derived.constitution,
          knowledge_base: derived.knowledge_base,
        }).eq('id', workspace_id);
        emit({ step: 'workspace_created' });

        // Universal drafter subscription — without this a workspace scores
        // accounts and pulls contacts fine but never drafts anything
        // (advanceAccounts treats a missing drafter subscription as a silent
        // setup gap, not an error). Empty structured_filter matches any
        // signal; the drafter's own icp_fit gate does the real filtering, so
        // this is the same generic subscription every workspace needs — no
        // vertical-specific wording. Mirrors the one-off
        // scripts/setup_universal_drafter.ts that bootstrapped this by hand
        // for the dogfood workspace before this fix existed.
        emit({ step: 'drafter' });
        const wsActor = { workspace_id: workspace_id as string, actor_kind: 'system' as const, actor_id: 'wizard' };
        const drafterSub = await callTool(supabase, wsActor, 'create_subscription', {
          owner_kind: 'agent',
          owner_id: 'claims_outbound_drafter',
          name: 'outbound_drafter',
          semantic_query: 'a company worth drafting outbound to: high ICP fit, with recent news, signal, or hook worth referencing in the email',
          structured_filter: {},
          threshold: 0.40,
          action_on_match: 'agent.run',
        });
        if (drafterSub.ok) {
          // agent_behavior isn't in the create_subscription tool schema yet —
          // same post-create patch used by every hand-rolled subscription script.
          await supabase.from('subscriptions').update({ agent_behavior: 'drafter' }).eq('id', drafterSub.target_id);
        }
        emit({ step: 'drafter_created' });

        // Optional starter source.
        let source_id: string | null = null;
        if (body.starter_source?.connector_type && body.starter_source?.name) {
          emit({ step: 'source' });
          // registry_meta, not registry: only the cron default is needed here,
          // and the full registry's module graph (.js specifiers) breaks
          // turbopack dev.
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

        emit({ step: 'done', workspace_id, source_id });
        controller.close();
      } catch (e) {
        emit({ step: 'error', error: e instanceof Error ? e.message : String(e) });
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}
