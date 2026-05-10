import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { healthCheck } from '@agent-crm/tools';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const sb = createServerClient();
  const data = await healthCheck(sb, ws);
  return NextResponse.json(data);
}
