import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool, getConnector } from '@agent-crm/tools';

export const runtime = 'nodejs';

interface ConfigureReq {
  workspace_id: string;
  connector_id: string;
  /** Field key -> typed value. Empty secret fields are ignored (keep existing). */
  values?: Record<string, string>;
  /** Contact connectors only: make this the primary / fallback source, or unset it. */
  contact_role?: 'primary' | 'fallback' | 'off';
  /** Remove every key + role for this connector. */
  disconnect?: boolean;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * POST /api/connectors/configure
 *
 * Saves one connector's keys + settings into workspaces.policy. Keys go in
 * policy.env; fields with a policy_path go where they belong (from_email,
 * monthly cap); contact connectors can be set as the primary or fallback source.
 * Reads the existing policy and writes the whole thing back so nothing else is
 * touched — reversible, so no approval gate (see decide-and-notify).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ConfigureReq | null;
  if (!body?.workspace_id || !body.connector_id) {
    return NextResponse.json({ error: 'workspace_id and connector_id required' }, { status: 400 });
  }
  const def = getConnector(body.connector_id);
  if (!def) return NextResponse.json({ error: `unknown connector: ${body.connector_id}` }, { status: 400 });

  const supabase = createServerClient();
  const existing = await supabase.from('workspaces').select('policy').eq('id', body.workspace_id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  const policy = JSON.parse(JSON.stringify(existing.data?.policy ?? {})) as Record<string, unknown>;
  const env = (policy.env ?? {}) as Record<string, string>;
  policy.env = env;

  if (body.disconnect) {
    for (const f of def.fields) {
      if (f.policy_path) setPath(policy, f.policy_path, undefined);
      else delete env[f.key];
    }
    if (def.provider_id) {
      const enr = (policy.enrichment ?? {}) as Record<string, unknown>;
      if (enr.contact_provider === def.provider_id) enr.contact_provider = 'none';
      if (enr.contact_provider_fallback === def.provider_id) enr.contact_provider_fallback = undefined;
      policy.enrichment = enr;
    }
  } else {
    const values = body.values ?? {};
    for (const f of def.fields) {
      const raw = values[f.key];
      if (raw === undefined || raw === null) continue;
      const val = String(raw).trim();  // a number field can arrive as a JS number
      // Skip an empty secret: the browser never received the current value, so
      // an empty box means "leave it as-is", not "clear it".
      if (f.type === 'secret' && val === '') continue;

      if (f.policy_path) {
        if (val === '') { setPath(policy, f.policy_path, undefined); continue; }
        setPath(policy, f.policy_path, f.type === 'number' ? Number(val) : val);
      } else {
        if (val === '') delete env[f.key];
        else env[f.key] = val;
      }
    }

    // Contact source role.
    if (def.provider_id && body.contact_role) {
      const enr = (policy.enrichment ?? {}) as Record<string, unknown>;
      if (body.contact_role === 'primary') {
        // If it was the fallback, clear that so it isn't listed twice.
        if (enr.contact_provider_fallback === def.provider_id) enr.contact_provider_fallback = undefined;
        enr.contact_provider = def.provider_id;
      } else if (body.contact_role === 'fallback') {
        if (enr.contact_provider === def.provider_id) enr.contact_provider = 'none';
        enr.contact_provider_fallback = def.provider_id;
      } else {
        if (enr.contact_provider === def.provider_id) enr.contact_provider = 'none';
        if (enr.contact_provider_fallback === def.provider_id) enr.contact_provider_fallback = undefined;
      }
      policy.enrichment = enr;
    }
  }

  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
    'set_workspace_policy',
    { policy },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, event_id: r.event_id });
}
