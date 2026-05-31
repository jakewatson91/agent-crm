'use client';

import { useParams } from 'next/navigation';
import { ConnectedServices } from '../_components/ConnectedServices';

export default function SettingsIntegrationsPage() {
  const params = useParams<{ ws: string }>();
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Integrations</h2>
      <div style={{ marginTop: '1rem' }}>
        <ConnectedServices workspace_id={params.ws} />
      </div>
    </div>
  );
}
