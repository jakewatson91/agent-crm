import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { query } from '@agent-crm/primitives';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { workspace_id?: string; nl?: string; perspective?: string } | null;
  if (!body?.workspace_id || !body?.nl) {
    return NextResponse.json({ error: 'workspace_id and nl required' }, { status: 400 });
  }
  const supabase = createServerClient();
  try {
    const result = await query(supabase, body.workspace_id, { nl: body.nl, perspective: body.perspective });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'unknown' }, { status: 500 });
  }
}
