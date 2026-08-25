import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import {
  CONNECTORS, CONNECTOR_CATEGORIES, MODEL_BEHAVIORS, resolveConnectorState,
  type ResolveStateInput,
} from '@agent-crm/tools';

export const runtime = 'nodejs';

/** Read a dot path out of a nested object (e.g. 'outreach.from_email'). */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

/**
 * GET /api/connectors/catalog?workspace_id=X
 *
 * Returns the connector registry plus each connector's saved state for this
 * workspace: which are configured, which is the primary/fallback contact source,
 * and any credit/auth alert the pipeline reported. Secret values never leave the
 * server — only the names of keys that are set travel over the wire.
 */
export async function GET(req: Request) {
  const workspace_id = new URL(req.url).searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data, error } = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const env = (policy.env ?? {}) as Record<string, string>;
  const enrichment = (policy.enrichment ?? {}) as Record<string, unknown>;
  const pipeline = (policy.pipeline ?? null) as ResolveStateInput['pipeline'];

  // Only the presence of a value matters here; the value itself stays server-side.
  const envPresent = new Set(
    Object.entries(env).filter(([, v]) => typeof v === 'string' && v.length > 0).map(([k]) => k),
  );
  // Keys provided by the deployment env (Render / self-host). The agent falls
  // back to these, so a key here counts as connected even if this workspace
  // hasn't pasted its own. Checked only for the specific names in the registry.
  const serverEnvPresent = new Set(
    CONNECTORS.flatMap((c) => c.fields).map((f) => f.key)
      .filter((k) => typeof process.env[k] === 'string' && process.env[k]!.length > 0),
  );

  // Non-secret policy_path values are safe to echo (from_email, monthly cap) so
  // the connect dialog can prefill them.
  const policyValues: Record<string, unknown> = {};
  for (const c of CONNECTORS) {
    for (const f of c.fields) {
      if (f.policy_path && f.type !== 'secret') policyValues[f.policy_path] = getPath(policy, f.policy_path);
    }
  }

  const input: ResolveStateInput = {
    envPresent,
    serverEnvPresent,
    policyValues,
    contactPrimary: enrichment.contact_provider as string | undefined,
    contactFallback: enrichment.contact_provider_fallback as string | undefined,
    pipeline,
  };

  const fieldSaved = (f: (typeof CONNECTORS)[number]['fields'][number]): boolean =>
    f.policy_path
      ? policyValues[f.policy_path] !== undefined && policyValues[f.policy_path] !== null && policyValues[f.policy_path] !== ''
      : envPresent.has(f.key);

  const connectors = CONNECTORS.map((def) => ({
    ...def,
    state: resolveConnectorState(def, input),
    // Prefill values for non-secret fields as strings (a number cap must render
    // in a text input and round-trip through the string-typed values map);
    // secret fields report only presence.
    values: Object.fromEntries(def.fields.map((f) => {
      if (f.type === 'secret') return [f.key, ''];
      const v = f.policy_path ? policyValues[f.policy_path] : env[f.key];
      return [f.key, v === undefined || v === null ? '' : String(v)];
    })),
    // Which fields have a value saved (names only — no secret values leave here).
    saved: Object.fromEntries(def.fields.map((f) => [f.key, fieldSaved(f)])),
  }));

  const llm = (policy.llm ?? {}) as Record<string, unknown>;
  const llmModels = (llm.models ?? {}) as Record<string, string | undefined>;
  return NextResponse.json({
    categories: CONNECTOR_CATEGORIES,
    connectors,
    contact: {
      primary: enrichment.contact_provider ?? 'none',
      fallback: enrichment.contact_provider_fallback ?? 'none',
      daily_cap: (enrichment.max_contact_pulls_per_run as number | undefined) ?? 8,
    },
    // The behavior list ships from here rather than being imported by the
    // settings component, because that component is a client component and
    // MODEL_BEHAVIORS lives in policy.ts, which imports node:crypto. webpack
    // cannot resolve a node: scheme in a browser bundle and tsc cannot see the
    // problem, which is the exact shape that broke every Render deploy for six
    // days in August. Sending it as data keeps the boundary intact.
    model_behaviors: MODEL_BEHAVIORS,
    // Which model id runs each behavior. `default` is the blanket setting; the
    // two legacy fields each name one behavior and are shown under that
    // behavior's own row, not as a global.
    models: {
      default: (llmModels.default ?? '') as string,
      ...Object.fromEntries(MODEL_BEHAVIORS.map((b) => {
        const legacy = b.key === 'drafter' ? (env.DRAFTER_MODEL ?? llm.drafter_model)
          : b.key === 'intake' ? (env.DEFAULT_CHAT_MODEL ?? llm.default_chat_model)
            : undefined;
        return [b.key, (llmModels[b.key] ?? legacy ?? '') as string];
      })),
    },
  });
}
