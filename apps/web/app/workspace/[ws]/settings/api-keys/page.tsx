'use client';

import { useParams } from 'next/navigation';
import { ApiKeysSection } from '../_components/ApiKeysSection';

export default function SettingsApiKeysPage() {
  const params = useParams<{ ws: string }>();
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>API keys</h2>
      <div style={{ marginTop: '1rem' }}>
        <ApiKeysSection workspace_id={params.ws} />
      </div>
    </div>
  );
}
