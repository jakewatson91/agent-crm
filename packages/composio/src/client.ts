/**
 * Thin wrapper over the Composio TS SDK.
 *
 * Why this layer exists:
 *  - Centralises Composio API key handling (one env var, one place to read it).
 *  - Standardises the `userId` we pass to Composio (`workspace:<id>`) so every
 *    workspace's connections are isolated in Composio's user namespace.
 *  - Returns plain shapes the rest of the app can use without depending on the
 *    Composio SDK directly. If we ever swap providers, only this file changes.
 */
import { Composio } from '@composio/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const COMPOSIO_USER_NAMESPACE = 'workspace:';

let _client: Composio | null = null;

function client(): Composio {
  if (_client) return _client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error('COMPOSIO_API_KEY is not set');
  }
  _client = new Composio({ apiKey });
  return _client;
}

export function composioUserId(workspace_id: string): string {
  return `${COMPOSIO_USER_NAMESPACE}${workspace_id}`;
}

/**
 * Get the auth-config id for a toolkit, creating one on demand if missing.
 *
 * Composio requires an `auth_config_id` to start an OAuth handoff. Rather than
 * making the operator create one per toolkit in the Composio dashboard, we
 * create them on first use via the SDK and cache them in `composio_auth_configs`.
 * Operator setup is just `COMPOSIO_API_KEY` — end-user setup is just clicking
 * Connect.
 *
 * Uses Composio's managed auth scheme (their OAuth client) — fine for dev /
 * dogfood. To swap to a custom OAuth client per toolkit later, change the
 * `type` here and pass `credentials`.
 */
async function getOrCreateAuthConfig(
  supabase: SupabaseClient,
  toolkit_slug: string,
): Promise<string> {
  const slug = toolkit_slug.toLowerCase();
  const { data: existing, error: readErr } = await supabase
    .from('composio_auth_configs')
    .select('composio_auth_config_id')
    .eq('toolkit_slug', slug)
    .maybeSingle();
  if (readErr) throw new Error(`composio_auth_configs read: ${readErr.message}`);
  if (existing?.composio_auth_config_id) return existing.composio_auth_config_id;

  const c = client();
  const created = await c.authConfigs.create(slug, { type: 'use_composio_managed_auth' });
  if (!created?.id) {
    throw new Error(`composio.authConfigs.create returned no id for ${slug}`);
  }

  const { error: upsertErr } = await supabase
    .from('composio_auth_configs')
    .upsert(
      { toolkit_slug: slug, composio_auth_config_id: created.id, is_composio_managed: true },
      { onConflict: 'toolkit_slug' },
    );
  if (upsertErr) throw new Error(`composio_auth_configs upsert: ${upsertErr.message}`);

  return created.id;
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE env vars missing for composio client');
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface AuthorizeResult {
  connection_id: string;
  redirect_url: string;
}

/**
 * Start an OAuth handoff for a toolkit. Returns the connect URL the user
 * must open in a browser plus the connection id we can poll later.
 *
 * Does not block on completion — callers should persist `redirect_url` so
 * the UI can re-open it, and poll `getConnectionStatus` to detect when the
 * user finishes the OAuth flow.
 */
export async function authorize(
  workspace_id: string,
  toolkit_slug: string,
): Promise<AuthorizeResult> {
  const c = client();
  const userId = composioUserId(workspace_id);
  const authConfigId = await getOrCreateAuthConfig(adminClient(), toolkit_slug);
  // `connectedAccounts.link(userId, authConfigId)` is the v3 entry point.
  // The legacy `toolkits.authorize(userId, slug)` / `connectedAccounts.initiate`
  // path was retired on 2026-04-24 for Composio-managed auth configs.
  const req = await c.connectedAccounts.link(userId, authConfigId);
  if (!req.redirectUrl) {
    throw new Error(`composio link: no redirectUrl returned for ${toolkit_slug}`);
  }
  return {
    connection_id: req.id,
    redirect_url: req.redirectUrl,
  };
}

export interface ConnectionStatus {
  connection_id: string;
  status: 'INITIATED' | 'ACTIVE' | 'EXPIRED' | 'FAILED' | 'INACTIVE' | string;
  toolkit_slug: string;
}

export async function getConnectionStatus(connection_id: string): Promise<ConnectionStatus> {
  const c = client();
  const acc = await c.connectedAccounts.get(connection_id);
  return {
    connection_id: acc.id,
    status: (acc.status ?? 'INITIATED').toString().toUpperCase(),
    toolkit_slug: (acc as { toolkit?: { slug?: string } }).toolkit?.slug ?? '',
  };
}

export async function disconnect(connection_id: string): Promise<void> {
  const c = client();
  // The SDK names this differently across versions; both forms are tried so a
  // minor SDK bump doesn't silently break disconnect.
  const ca = c.connectedAccounts as unknown as {
    delete?: (id: string) => Promise<unknown>;
    disable?: (id: string) => Promise<unknown>;
  };
  if (typeof ca.delete === 'function') {
    await ca.delete(connection_id);
  } else if (typeof ca.disable === 'function') {
    await ca.disable(connection_id);
  } else {
    throw new Error('composio sdk: no delete/disable method on connectedAccounts');
  }
}

export interface ExecuteResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute a Composio action for a given workspace's connection.
 *
 * The caller is responsible for scope-gating (read vs write vs dangerous)
 * before calling this. This function just proxies.
 */
export async function execute(
  workspace_id: string,
  action_slug: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  const c = client();
  const userId = composioUserId(workspace_id);
  try {
    // `dangerouslySkipVersionCheck: true` opts into "use latest version of
    // each toolkit" without us having to pin specific version strings. Without
    // this the SDK throws `ComposioToolVersionRequiredError` because the
    // default version resolves to "latest". Pin per toolkit later if we need
    // reproducibility.
    const res = await c.tools.execute(action_slug, {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    const r = res as { data?: unknown; error?: unknown; successful?: boolean };
    const ok = r.successful ?? !r.error;
    return {
      ok,
      data: r.data,
      error: r.error ? String(r.error) : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Pull the connected user's profile after OAuth completes. Best-effort —
 * different toolkits use different "get profile" slugs, so we try the
 * common conventions and return whatever sticks.
 */
export async function fetchUserProfile(
  workspace_id: string,
  toolkit_slug: string,
): Promise<Record<string, unknown> | null> {
  const candidates: Record<string, string> = {
    gmail: 'GMAIL_GET_PROFILE',
    slack: 'SLACK_FETCH_CURRENT_USER_INFO',
    googlecalendar: 'GOOGLECALENDAR_GET_CALENDAR',
    hubspot: 'HUBSPOT_GET_ACCOUNT_DETAILS',
    salesforce: 'SALESFORCE_GET_USER_INFO',
  };
  const slug = candidates[toolkit_slug.toLowerCase()];
  if (!slug) return null;
  const res = await execute(workspace_id, slug, {});
  if (!res.ok) return null;
  return (res.data as Record<string, unknown>) ?? null;
}
