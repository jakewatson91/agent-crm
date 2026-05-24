'use client';

import { useParams } from 'next/navigation';
import { MembersSection } from '../_components/MembersSection';

export default function SettingsMembersPage() {
  const params = useParams<{ ws: string }>();
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Members</h2>
      <div style={{ marginTop: '1rem' }}>
        <MembersSection workspace_id={params.ws} />
      </div>
    </div>
  );
}
