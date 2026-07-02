import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveEnvVar, getConnector } from '@agent-crm/tools';

export const runtime = 'nodejs';

type VerifyStatus = 'ok' | 'no_credits' | 'auth' | 'error' | 'no_key';
interface VerifyResult { ok: boolean; status: VerifyStatus; detail: string; credits?: string }

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Live check for one connector's key. Each probe is free or nearly free and only
 * runs when the user clicks "Test", so we never burn credits in the background.
 * Where a provider exposes a balance, we report it — that's the "out of credits"
 * warning surfacing at the source.
 */
async function probe(id: string, key: string): Promise<VerifyResult> {
  switch (id) {
    case 'hunter': {
      const res = await timedFetch(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`);
      if (res.status === 401) return { ok: false, status: 'auth', detail: 'Key rejected by Hunter.' };
      if (!res.ok) return { ok: false, status: 'error', detail: `Hunter returned ${res.status}.` };
      const j = await res.json() as { data?: { requests?: { searches?: { used?: number; available?: number } } } };
      const s = j.data?.requests?.searches;
      if (s && typeof s.available === 'number') {
        const left = s.available - (s.used ?? 0);
        if (left <= 0) return { ok: false, status: 'no_credits', detail: 'No Hunter lookups left this month.', credits: `0 / ${s.available}` };
        return { ok: true, status: 'ok', detail: 'Connected.', credits: `${left} / ${s.available} left` };
      }
      return { ok: true, status: 'ok', detail: 'Connected.' };
    }
    case 'deepseek': {
      const res = await timedFetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (res.status === 401) return { ok: false, status: 'auth', detail: 'Key rejected by DeepSeek.' };
      if (!res.ok) return { ok: false, status: 'error', detail: `DeepSeek returned ${res.status}.` };
      const j = await res.json() as { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: string }> };
      const bal = j.balance_infos?.[0];
      const credits = bal ? `${bal.total_balance} ${bal.currency ?? ''}`.trim() : undefined;
      if (j.is_available === false) return { ok: false, status: 'no_credits', detail: 'DeepSeek balance is empty.', credits };
      return { ok: true, status: 'ok', detail: 'Connected.', credits: credits ? `${credits} available` : undefined };
    }
    case 'openai': {
      const res = await timedFetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.status === 401) return { ok: false, status: 'auth', detail: 'Key rejected by OpenAI.' };
      if (res.status === 429) return { ok: false, status: 'no_credits', detail: 'OpenAI rate/quota limit hit.' };
      if (!res.ok) return { ok: false, status: 'error', detail: `OpenAI returned ${res.status}.` };
      return { ok: true, status: 'ok', detail: 'Connected.' };
    }
    case 'resend': {
      const res = await timedFetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, status: 'auth', detail: 'Key rejected by Resend.' };
      if (!res.ok) return { ok: false, status: 'error', detail: `Resend returned ${res.status}.` };
      return { ok: true, status: 'ok', detail: 'Connected.' };
    }
    // No free probe for these — a key being present is the most we check without
    // spending credits. The pipeline surfaces real failures if they happen.
    case 'explorium':
    case 'exa':
    case 'ai_gateway':
    default:
      return { ok: true, status: 'ok', detail: 'Key saved. No live check for this provider — the agent reports a problem if the key fails.' };
  }
}

/**
 * POST /api/connectors/verify  { workspace_id, connector_id }
 * Runs the connector's live check with the workspace's saved key.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { workspace_id?: string; connector_id?: string } | null;
  if (!body?.workspace_id || !body.connector_id) {
    return NextResponse.json({ error: 'workspace_id and connector_id required' }, { status: 400 });
  }
  const def = getConnector(body.connector_id);
  if (!def) return NextResponse.json({ error: `unknown connector: ${body.connector_id}` }, { status: 400 });

  const secretField = def.fields.find((f) => f.type === 'secret');
  if (!secretField) return NextResponse.json({ result: { ok: true, status: 'ok', detail: 'No key needed.' } });

  const supabase = createServerClient();
  const policy = await getPolicy(supabase, body.workspace_id);
  const key = resolveEnvVar(policy, secretField.key);
  if (!key) {
    const r: VerifyResult = { ok: false, status: 'no_key', detail: `No ${secretField.key} saved yet.` };
    return NextResponse.json({ result: r });
  }

  try {
    const result = await probe(def.id, key);
    return NextResponse.json({ result });
  } catch (e) {
    const detail = e instanceof Error && e.name === 'AbortError' ? 'Check timed out.' : (e instanceof Error ? e.message : String(e));
    return NextResponse.json({ result: { ok: false, status: 'error', detail } satisfies VerifyResult });
  }
}
