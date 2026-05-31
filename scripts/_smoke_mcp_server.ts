/**
 * Smoke test the stdio MCP server against a running dev server (localhost:3000).
 *
 * Provisions a temporary API key for the demo workspace, spawns
 * `node packages/mcp-server/dist/cli.js` with env vars, runs the MCP
 * handshake + tools/list + a read tool/call, then revokes the key.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const URL = 'http://localhost:3000';

interface JsonRpcMsg {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
}

async function provisionKey(): Promise<{ id: string; secret: string }> {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id').eq('id', WS).maybeSingle();
  if (!ws.data) throw new Error(`workspace ${WS} not found`);
  // Prefer the workspace's recorded owner; fall back to the first auth user
  // so the smoke test runs before `bootstrap_owner.ts` is executed.
  const owner = await sb.from('workspace_members').select('user_id').eq('workspace_id', WS).eq('role', 'owner').limit(1).maybeSingle();
  let createdBy = owner.data?.user_id as string | undefined;
  if (!createdBy) {
    const users = await sb.auth.admin.listUsers();
    createdBy = users.data?.users?.[0]?.id;
  }
  if (!createdBy) throw new Error('no auth user available to attribute the smoke key to');
  const secret = `acrm_${randomBytes(32).toString('base64url')}`;
  const key_hash = createHash('sha256').update(secret).digest('hex');
  const ins = await sb.from('workspace_api_keys').insert({
    workspace_id: WS,
    name: `mcp-smoke-${Date.now()}`,
    key_hash,
    prefix: secret.slice(0, 12),
    created_by: createdBy,
  }).select('id').single();
  if (ins.error || !ins.data) throw new Error(`api key insert failed: ${ins.error?.message}`);
  return { id: ins.data.id, secret };
}

async function revoke(id: string): Promise<void> {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  await sb.from('workspace_api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id);
}

function spawnMcp(apiKey: string) {
  return spawn('node', ['packages/mcp-server/dist/cli.js'], {
    env: {
      ...process.env,
      AGENT_CRM_URL: URL,
      AGENT_CRM_API_KEY: apiKey,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

async function run() {
  console.log('[smoke] provisioning api key…');
  const { id, secret } = await provisionKey();
  console.log(`[smoke] api key ${secret.slice(0, 12)}… created (id=${id})`);

  const child = spawnMcp(secret);

  const responses: JsonRpcMsg[] = [];
  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { responses.push(JSON.parse(line) as JsonRpcMsg); } catch { /* skip */ }
    }
  });

  const send = (m: JsonRpcMsg) => child.stdin!.write(JSON.stringify(m) + '\n');
  const wait = async (id: number, timeoutMs = 8000): Promise<JsonRpcMsg> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = responses.find((x) => x.id === id);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`timed out waiting for response id=${id}`);
  };

  try {
    // 1. initialize
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
    const initRes = await wait(1);
    if (initRes.error) throw new Error(`initialize failed: ${initRes.error.message}`);
    console.log('[smoke] initialize ok');
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    // 2. tools/list
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await wait(2);
    if (list.error) throw new Error(`tools/list failed: ${list.error.message}`);
    const tools = ((list.result as { tools: Array<{ name: string }> })?.tools) ?? [];
    console.log(`[smoke] tools/list returned ${tools.length} tools (sample: ${tools.slice(0, 3).map((t) => t.name).join(', ')})`);
    if (tools.length === 0) throw new Error('expected >0 tools');

    // 3. tools/call → health_check (no-arg, safe read)
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } });
    const call = await wait(3);
    if (call.error) throw new Error(`tools/call failed: ${call.error.message}`);
    const content = (call.result as { content: Array<{ type: string; text: string }> }).content;
    if (!content?.[0]?.text) throw new Error('expected text content');
    const parsed = JSON.parse(content[0].text);
    console.log('[smoke] tools/call health_check ok →', JSON.stringify(parsed).slice(0, 160));

    console.log('[smoke] ALL OK');
  } finally {
    child.kill();
    await revoke(id);
    console.log('[smoke] api key revoked');
  }
}

run().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
