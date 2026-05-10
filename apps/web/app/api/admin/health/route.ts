import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { healthCheck, tokenSummary } from '@agent-crm/tools';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const sb = createServerClient();
  const [health, day, week] = await Promise.all([
    healthCheck(sb, ws),
    tokenSummary(sb, ws, { since_hours: 24 }),
    tokenSummary(sb, ws, { since_hours: 168 }),
  ]);
  return NextResponse.json({
    ...health,
    tokens_24h: { runs: day.runs, input: day.input_tokens, output: day.output_tokens, cached: day.cached_input_tokens },
    tokens_7d: { runs: week.runs, input: week.input_tokens, output: week.output_tokens, cached: week.cached_input_tokens },
  });
}
