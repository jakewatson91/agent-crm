import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerClient } from '@agent-crm/db';
import { mergeAccounts, dismissMergeCandidate } from '@agent-crm/tools';

export const runtime = 'nodejs';

interface MergeReq {
  workspace_id: string;
  action: 'merge' | 'dismiss';
  canonical_id: string;
  duplicate_id: string;
}

// Human-approved merge of a detected duplicate account (or a dismissal of the
// proposal). The detector only proposes; nothing merges without this call.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as MergeReq | null;
  if (!body?.workspace_id || !body?.action || !body?.canonical_id || !body?.duplicate_id) {
    return NextResponse.json({ error: 'workspace_id, action, canonical_id, duplicate_id required' }, { status: 400 });
  }
  if (body.canonical_id === body.duplicate_id) {
    return NextResponse.json({ error: 'canonical and duplicate must differ' }, { status: 400 });
  }
  const supabase = createServerClient();
  try {
    if (body.action === 'dismiss') {
      await dismissMergeCandidate(supabase, body.workspace_id, body.canonical_id, body.duplicate_id);
      return NextResponse.json({ ok: true });
    }
    const result = await mergeAccounts(supabase, body.workspace_id, body.canonical_id, body.duplicate_id);
    revalidateTag('feed');
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
