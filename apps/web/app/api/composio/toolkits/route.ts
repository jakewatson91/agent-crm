import { NextResponse } from 'next/server';
import { listToolkits } from '@agent-crm/composio';

export const runtime = 'nodejs';

/**
 * GET /api/composio/toolkits
 *
 * Returns the curated catalog of toolkits agent-crm knows how to drive.
 * Each entry includes the actions the agent can execute and their scope
 * (read / write / dangerous) so the UI can preview what enabling a
 * toolkit will let the agent do.
 */
export async function GET() {
  const toolkits = listToolkits().map((tk) => ({
    slug: tk.slug,
    label: tk.label,
    description: tk.description,
    actions: tk.actions.map((a) => ({ slug: a.slug, scope: a.scope, summary: a.summary })),
  }));
  return NextResponse.json({ toolkits });
}
