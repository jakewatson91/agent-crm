#!/usr/bin/env node
/**
 * Entry point invoked by Claude Desktop / Cursor / any MCP client.
 * Reads config from env vars (the MCP protocol uses stdio for the wire,
 * so flags would collide with the transport).
 */
import { runStdio } from './index.js';

const url = process.env.AGENT_CRM_URL;
const apiKey = process.env.AGENT_CRM_API_KEY;
const path = process.env.AGENT_CRM_MCP_PATH;

if (!url) {
  console.error('AGENT_CRM_URL is required (e.g. https://crm.example.com or http://localhost:3000)');
  process.exit(1);
}
if (!apiKey) {
  console.error('AGENT_CRM_API_KEY is required. Generate one in Settings → API Keys.');
  process.exit(1);
}
if (!/^acrm_[A-Za-z0-9_-]+$/.test(apiKey)) {
  console.error('AGENT_CRM_API_KEY does not look like an agent-crm key (expected `acrm_...`).');
  process.exit(1);
}

runStdio({ url, apiKey, path }).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`agent-crm-mcp: fatal: ${msg}`);
  process.exit(1);
});
