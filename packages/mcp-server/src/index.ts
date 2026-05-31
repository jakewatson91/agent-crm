/**
 * Thin stdio MCP server for agent-crm. Forwards tools/list + tools/call to
 * the workspace's /api/mcp endpoint with Bearer auth. The remote endpoint
 * is the source of truth for the tool catalog — we don't duplicate schemas
 * here so a server upgrade picks up new tools automatically.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface ServerConfig {
  /** Base URL of an agent-crm deployment, e.g. https://crm.example.com */
  url: string;
  /** `acrm_...` API key issued in Settings → API Keys */
  apiKey: string;
  /** Optional override for the catalog/call path. Defaults to `/api/mcp`. */
  path?: string;
}

interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: number;
  result: T;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

function isJsonRpcError<T>(r: JsonRpcResponse<T>): r is JsonRpcError {
  return 'error' in r;
}

function endpoint(cfg: ServerConfig): string {
  const base = cfg.url.replace(/\/+$/, '');
  const path = cfg.path ?? '/api/mcp';
  return `${base}${path}`;
}

async function jsonRpcCall<T>(cfg: ServerConfig, method: string, params: unknown): Promise<T> {
  const res = await fetch(endpoint(cfg), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`agent-crm /api/mcp ${method} → ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  const payload = (await res.json()) as JsonRpcResponse<T>;
  if (isJsonRpcError(payload)) {
    throw new Error(`agent-crm tool error: ${payload.error.message}`);
  }
  return payload.result;
}

export function buildServer(cfg: ServerConfig): Server {
  const server = new Server(
    { name: 'agent-crm', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await jsonRpcCall<{ tools: RemoteToolDescriptor[] }>(cfg, 'tools/list', {});
    return { tools: result.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = await jsonRpcCall<unknown>(cfg, 'tools/call', { name, arguments: args ?? {} });
    // MCP clients expect a `content` array. We wrap the tool's structured
    // result as one JSON text block — Claude Desktop and Cursor both handle
    // this fine, and the structured shape is preserved verbatim for the model.
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  return server;
}

export async function runStdio(cfg: ServerConfig): Promise<void> {
  const server = buildServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
