/**
 * Secret-value masking for policy.env over the wire.
 *
 * Workspace settings need to render which env vars are configured, but the
 * raw secret values should never leave the server. We replace secret-shaped
 * values with a sentinel before serializing the response. On the way back
 * (workspace update), the sentinel means "keep the existing value" — only
 * non-sentinel values overwrite.
 *
 * Same regex (KEY|SECRET|TOKEN|PASSWORD|PWD)$ used in EnvVarsEditor to
 * default the "mask" toggle. Keep both in sync if you ever extend.
 */

export const MASKED_SENTINEL = '__agent_crm_masked__';
const SECRET_RE = /(KEY|SECRET|TOKEN|PASSWORD|PWD)$/i;

export function isSecretKey(name: string): boolean {
  return SECRET_RE.test(name);
}

/** Replace secret-shaped values in an env dict with the sentinel. */
export function maskEnv(env: Record<string, string> | undefined | null): Record<string, string> {
  if (!env || typeof env !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    out[k] = (isSecretKey(k) && v.length > 0) ? MASKED_SENTINEL : v;
  }
  return out;
}

/**
 * Merge an incoming env into the existing env, restoring real values where
 * the incoming value is the sentinel. Used by /api/workspace/update.
 */
export function unmaskEnv(
  incoming: Record<string, string> | undefined | null,
  existing: Record<string, string> | undefined | null,
): Record<string, string> {
  const inc = (incoming ?? {}) as Record<string, string>;
  const exi = (existing ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inc)) {
    if (typeof v !== 'string') continue;
    if (v === MASKED_SENTINEL && typeof exi[k] === 'string') {
      out[k] = exi[k]!;
    } else {
      out[k] = v;
    }
  }
  return out;
}
