/**
 * POST /api/workspaces/arguments { workspace_id, arguments }
 *
 * Save this workspace's arguments and nothing else. Narrow on purpose: the
 * setup wizard has no reason to hold the whole policy in the browser just to
 * write four fields, and a full-policy round trip from a screen that never read
 * the rest of the policy is how a save silently clears something it never knew
 * about.
 *
 * This exists because the argument was derived silently at setup and left in a
 * Settings tab nobody had a reason to open. It is the single most load-bearing
 * thing a customer ever types, it decides what every message says, and the
 * customer had never seen it.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool, getPolicy, type DrafterArgument } from '@agent-crm/tools';

export const runtime = 'nodejs';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Keep what a person actually filled in. `when`, `so` and `ask` are the chain,
 * so an entry missing any of them is dropped rather than repaired: a half
 * argument would be matched to accounts and used like a whole one.
 *
 * Unlike the wizard's own coercion this preserves `proven_at`, because here the
 * human IS the confirmation. Nothing is capped: three is all a model may guess,
 * and a customer who wants six arguments has earned them.
 */
function coerce(raw: unknown): DrafterArgument[] {
  if (!Array.isArray(raw)) return [];
  const out: DrafterArgument[] = [];
  const seen = new Set<string>();
  for (const item of raw as Array<Record<string, unknown>>) {
    const when = str(item?.when), so = str(item?.so), ask = str(item?.ask);
    if (!when || !so || !ask) continue;
    const id = (str(item?.id) || str(item?.label) || 'argument')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'argument';
    if (seen.has(id)) continue;
    seen.add(id);
    const only_if = str(item?.only_if);
    const proven_at = str(item?.proven_at);
    out.push({
      id,
      label: str(item?.label) || id,
      when,
      ...(only_if ? { only_if } : {}),
      so,
      ask,
      ...(proven_at ? { proven_at } : {}),
      enabled: item?.enabled !== false,
    });
  }
  return out;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { workspace_id?: string; arguments?: unknown } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const policy = await getPolicy(supabase, body.workspace_id) as Record<string, any>;
  const next = coerce(body.arguments);

  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
    'set_workspace_policy',
    { policy: { ...policy, drafter: { ...(policy.drafter ?? {}), arguments: next } } },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
  return NextResponse.json({ ok: true, arguments: next });
}
