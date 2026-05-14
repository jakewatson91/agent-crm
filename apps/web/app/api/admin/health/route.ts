import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { healthCheck, tokenSummary } from '@agent-crm/tools';

export const dynamic = 'force-dynamic';

/**
 * Count drafted touches and scored accounts in a window so we can attribute
 * spend to useful output. tokens_per_drafted_touch and tokens_per_scored_account
 * are the only credit-efficiency numbers that actually matter — raw token
 * counts don't tell you whether you're getting cheaper or just doing less work.
 */
async function attributionMetrics(sb: ReturnType<typeof createServerClient>, ws: string, hours: number) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // touch_drafts live in channel_posts; channel_posts has no workspace_id, so
  // we join through channels.
  const wsChannels = await sb.from('channels').select('id').eq('workspace_id', ws);
  const chIds = ((wsChannels.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  const drafts = chIds.length
    ? await sb.from('channel_posts')
        .select('id', { count: 'exact', head: true })
        .in('channel_id', chIds)
        .eq('kind', 'touch_draft')
        .gte('created_at', since)
    : { count: 0 } as { count: number };

  // scored = distinct subject_entity in icp_fit facts asserted in the window.
  const fits = await sb.from('facts')
    .select('subject_entity')
    .eq('workspace_id', ws)
    .eq('predicate', 'icp_fit')
    .gte('created_at', since)
    .limit(5000);
  const scored = new Set<string>(((fits.data ?? []) as Array<{ subject_entity: string }>).map((f) => f.subject_entity));

  return {
    drafted_touches: drafts.count ?? 0,
    scored_accounts: scored.size,
  };
}

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const sb = createServerClient();
  const [health, day, week, attr24, attr7d] = await Promise.all([
    healthCheck(sb, ws),
    tokenSummary(sb, ws, { since_hours: 24 }),
    tokenSummary(sb, ws, { since_hours: 168 }),
    attributionMetrics(sb, ws, 24),
    attributionMetrics(sb, ws, 168),
  ]);

  const tot24 = day.input_tokens + day.output_tokens;
  const tot7d = week.input_tokens + week.output_tokens;

  return NextResponse.json({
    ...health,
    tokens_24h: {
      runs: day.runs,
      input: day.input_tokens,
      output: day.output_tokens,
      cached: day.cached_input_tokens,
      cache_rate: day.input_tokens > 0 ? +(day.cached_input_tokens / day.input_tokens).toFixed(3) : 0,
      drafted_touches: attr24.drafted_touches,
      scored_accounts: attr24.scored_accounts,
      tokens_per_drafted_touch: attr24.drafted_touches > 0 ? Math.round(tot24 / attr24.drafted_touches) : null,
      tokens_per_scored_account: attr24.scored_accounts > 0 ? Math.round(tot24 / attr24.scored_accounts) : null,
    },
    tokens_7d: {
      runs: week.runs,
      input: week.input_tokens,
      output: week.output_tokens,
      cached: week.cached_input_tokens,
      cache_rate: week.input_tokens > 0 ? +(week.cached_input_tokens / week.input_tokens).toFixed(3) : 0,
      drafted_touches: attr7d.drafted_touches,
      scored_accounts: attr7d.scored_accounts,
      tokens_per_drafted_touch: attr7d.drafted_touches > 0 ? Math.round(tot7d / attr7d.drafted_touches) : null,
      tokens_per_scored_account: attr7d.scored_accounts > 0 ? Math.round(tot7d / attr7d.scored_accounts) : null,
    },
  });
}
