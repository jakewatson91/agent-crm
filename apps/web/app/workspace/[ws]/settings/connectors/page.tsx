'use client';

import { useParams } from 'next/navigation';
import { ConnectorHub } from '../_components/ConnectorHub';

export default function SettingsConnectorsPage() {
  const params = useParams<{ ws: string }>();
  return (
    <>
      <ConnectorHub workspace_id={params.ws} />
      <style>{`
        .connector-card { transition: border-color 120ms ease, box-shadow 120ms ease, transform 80ms ease; }
        .connector-card:hover { border-color: var(--border-strong); box-shadow: 0 4px 16px rgba(20,18,14,0.06); }
        .connector-card:active { transform: translateY(1px); }
      `}</style>
    </>
  );
}
