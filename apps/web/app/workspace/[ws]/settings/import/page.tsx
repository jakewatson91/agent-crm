'use client';

/**
 * Bring in more data later: same panel new workspaces see during setup, kept
 * here for re-imports and top-ups after the initial CSV. First-run import now
 * happens in the creation wizard (/workspace/new) — this page isn't the
 * primary path anymore.
 */
import { useParams } from 'next/navigation';
import { CsvImportPanel } from '../../../../_components/CsvImportPanel';

export default function ImportPage() {
  const params = useParams<{ ws: string }>();

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Import from a CSV</h2>
      <p style={{ color: 'var(--text-2)', fontSize: '.9rem', marginTop: '.4rem' }}>
        Bring in more accounts and contacts any time — from an old CRM export, a new list, or a top-up to what
        you imported at setup. Safe to re-run: duplicates are merged, not re-created. For ongoing data, point a
        tool at your <strong>inbound webhook</strong> source instead.
      </p>
      <div style={{ marginTop: '1.25rem' }}>
        <CsvImportPanel workspaceId={params.ws} />
      </div>
    </div>
  );
}
