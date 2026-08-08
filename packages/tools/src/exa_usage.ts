/**
 * Real billed Exa cost, read from Exa's own account, instead of guessing from
 * assumed unit prices. Requires a Team Management SERVICE key (Settings ->
 * Connectors -> Exa -> "Service key", separate from the regular search API
 * key) — not every plan exposes one. When it's not configured, callers fall
 * back to the modeled estimate in report.ts.
 */

const ADMIN_API = 'https://admin-api.exa.ai/team-management';
const FETCH_TIMEOUT_MS = 10_000;

interface ApiKeyLite { id: string; name?: string }

async function listApiKeys(serviceKey: string): Promise<ApiKeyLite[]> {
  const r = await fetch(`${ADMIN_API}/api-keys`, {
    headers: { 'x-api-key': serviceKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`list-api-keys ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { apiKeys?: ApiKeyLite[] };
  return j.apiKeys ?? [];
}

async function getKeyUsageCost(serviceKey: string, keyId: string, startDate: string, endDate: string): Promise<number> {
  const url = `${ADMIN_API}/api-keys/${keyId}/usage?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
  const r = await fetch(url, {
    headers: { 'x-api-key': serviceKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`usage ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { total_cost_usd?: number };
  return j.total_cost_usd ?? 0;
}

export interface ExaUsageResult {
  ok: boolean;
  totalCostUsd: number | null;
  keysCounted: number;
  error?: string;
}

/**
 * Sum real billed cost across every API key on the team for the given window.
 * We sum rather than match a specific key because the usage API identifies
 * keys by an internal id, not the key string itself — there's no way to tell
 * which id corresponds to the EXA_API_KEY actually in use without asking Exa
 * support. Fine for a single-key account (the common case); overcounts if the
 * team has other keys spending independently.
 */
export async function fetchExaActualCost(serviceKey: string, startDate: string, endDate: string): Promise<ExaUsageResult> {
  try {
    const keys = await listApiKeys(serviceKey);
    if (!keys.length) return { ok: false, totalCostUsd: null, keysCounted: 0, error: 'no API keys on team' };
    let total = 0;
    for (const k of keys) total += await getKeyUsageCost(serviceKey, k.id, startDate, endDate);
    return { ok: true, totalCostUsd: total, keysCounted: keys.length };
  } catch (e) {
    return { ok: false, totalCostUsd: null, keysCounted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
