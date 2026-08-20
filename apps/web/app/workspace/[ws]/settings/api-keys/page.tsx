'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiKeysSection } from '../_components/ApiKeysSection';

export default function SettingsApiKeysPage() {
  const params = useParams<{ ws: string }>();
  const [origin, setOrigin] = useState<string>('');
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const snippet = JSON.stringify({
    mcpServers: {
      'agent-crm': {
        command: 'npx',
        args: ['-y', '@agent-crm/mcp-server'],
        env: {
          AGENT_CRM_URL: origin || 'https://your-agent-crm-url',
          AGENT_CRM_API_KEY: 'acrm_...',
        },
      },
    },
  }, null, 2);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>API keys</h2>
      <div style={{ marginTop: '1rem' }}>
        <ApiKeysSection workspace_id={params.ws} />
      </div>

      <h3 style={{ marginTop: '2.5rem' }}>Use from Claude Desktop or Cursor</h3>
      <p style={{ color: 'var(--text-2)', marginTop: '0.5rem' }}>
        Issue a key above, paste it into the snippet, drop the whole block into your client's MCP config.
      </p>
      <pre style={{
        background: 'var(--panel-2)',
        padding: '0.75rem 1rem',
        borderRadius: 6,
        overflow: 'auto',
        fontSize: 12,
        lineHeight: 1.45,
      }}>{snippet}</pre>
      <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
        Claude Desktop config:{' '}
        <code>~/Library/Application Support/Claude/claude_desktop_config.json</code><br />
        Cursor config: <code>~/.cursor/mcp.json</code>
      </p>
    </div>
  );
}
