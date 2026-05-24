/**
 * POST /api/workspaces/regenerate { workspace_id, about }
 *
 * Re-runs the wizard's `deriveDefaults` LLM call against the supplied `about`
 * text and returns the derived fields. Does NOT persist — the Settings page
 * shows the result inline, lets the user review, then saves through the
 * normal save action.
 */
import { NextResponse } from 'next/server';
import { deriveDefaults } from '../_derive_defaults';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { workspace_id?: string; about?: string } | null;
  if (!body?.workspace_id || !body?.about?.trim()) {
    return NextResponse.json({ error: 'workspace_id and about required' }, { status: 400 });
  }
  const derived = await deriveDefaults(body.about);
  return NextResponse.json({ ok: true, derived });
}
