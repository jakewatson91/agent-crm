# @agent-crm/mcp-server

A stdio MCP server that points Claude Desktop, Cursor, or any MCP client at an agent-crm workspace.

Tools are loaded from the workspace's `/api/mcp` endpoint at runtime — upgrading the agent-crm server picks up new tools automatically with no client update.

## Setup

1. Open agent-crm → Settings → API Keys → **New key**. Copy the `acrm_…` secret (shown once).
2. Pick how the client should launch the binary:

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agent-crm": {
      "command": "npx",
      "args": ["-y", "@agent-crm/mcp-server"],
      "env": {
        "AGENT_CRM_URL": "https://crm.example.com",
        "AGENT_CRM_API_KEY": "acrm_…"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

Same shape as Claude Desktop. Restart Cursor after editing.

### Local checkout (no npm publish needed)

```json
{
  "mcpServers": {
    "agent-crm": {
      "command": "node",
      "args": ["/absolute/path/to/agent-crm/packages/mcp-server/dist/cli.js"],
      "env": {
        "AGENT_CRM_URL": "http://localhost:3000",
        "AGENT_CRM_API_KEY": "acrm_…"
      }
    }
  }
}
```

## Env vars

| Name                  | Required | Default     | Notes |
|-----------------------|----------|-------------|-------|
| `AGENT_CRM_URL`       | yes      | —           | Base URL of the deployment, no trailing slash. |
| `AGENT_CRM_API_KEY`   | yes      | —           | Must match `acrm_<…>` format. |
| `AGENT_CRM_MCP_PATH`  | no       | `/api/mcp`  | Override only if you've mounted the route elsewhere. |

## Verifying

After restarting the client, ask: *"List the tools you have from agent-crm."* You should see the full catalog (`list_entities`, `get_entity`, `score_entity`, etc.). If the catalog is empty, the URL is wrong; if every call returns 401, the key is wrong or revoked.

## Local development

```sh
pnpm --filter @agent-crm/mcp-server build
node packages/mcp-server/dist/cli.js   # blocks on stdin, waiting for MCP frames
```

The repo's smoke test (`scripts/_smoke_mcp_server.ts`) provisions a throwaway key, does an `initialize` + `tools/list` + `tools/call`, then revokes the key.
