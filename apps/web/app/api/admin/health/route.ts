import { NextRequest, NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { createServerClient } from '@agent-crm/db';
import { healthCheck, tokenSummary } from '@agent-crm/tools/reads';
import { fetchAll } from '@agent-crm/tools';

/**
 * Both panels below used to take a list of this workspace's channel ids and
 * filter on `.in('channel_id', ids)`. That list came back capped at PostgREST's
 * 1000 rows and this workspace has 1,961 channels, so every count here was a
 * count of roughly half the workspace, presented as the whole of it. The
 * embedded channels!inner filter joins to the parent instead, which has no list
 * to truncate. Same pattern as reads.ts stale_drafts and sweep.ts claims.
 */
async function attributionMetrics(sb: ReturnType<typeof createServerClient>, ws: string, hours: number) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const [drafts, fits] = await Promise.all([
    sb.from('channel_posts')
      .select('id, channels!inner(workspace_id)', { count: 'exact', head: true })
      .eq('channels.workspace_id', ws)
      .eq('kind', 'touch_draft')
      .gte('created_at', since),
    // Distinct accounts scored, so this one needs the rows, not a count.
    fetchAll<{ subject_entity: string }>((from, to) => sb.from('facts')
      .select('subject_entity')
      .eq('workspace_id', ws)
      .eq('predicate', 'icp_fit')
      .gte('created_at', since)
      .order('subject_entity').range(from, to)),
  ]);

  const scored = new Set<string>(fits.map((f) => f.subject_entity));
  return { drafted_touches: drafts.count ?? 0, scored_accounts: scored.size };
}

async function actionDistribution(sb: ReturnType<typeof createServerClient>, ws: string, hours: number) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  // Count each action type with a targeted ilike filter, no body data read.
  const base = (tag: string) =>
    sb.from('channel_posts')
      .select('id, channels!inner(workspace_id)', { count: 'exact', head: true })
      .eq('channels.workspace_id', ws)
      .eq('kind', 'decision')
      .gte('created_at', since)
      .ilike('body', `[${tag}]%`);
  const [draftCount, watchOnly, deepResearch, drop, cont] = await Promise.all([
    sb.from('channel_posts').select('id, channels!inner(workspace_id)', { count: 'exact', head: true })
      .eq('channels.workspace_id', ws).eq('kind', 'touch_draft').gte('created_at', since),
    base('watch_only'),
    base('deep_research'),
    base('drop'),
    base('continue'),
  ]);
  return {
    draft_outreach: draftCount.count ?? 0,
    watch_only: watchOnly.count ?? 0,
    deep_research: deepResearch.count ?? 0,
    drop: drop.count ?? 0,
    continue: cont.count ?? 0,
  };
}

const getHealthData = unstable_cache(
  async (ws: string) => {
    const sb = createServerClient();

    const [health, day, week, attr24, attr7d, actions24, actions7d] = await Promise.all([
      healthCheck(sb, ws),
      tokenSummary(sb, ws, { since_hours: 24 }),
      tokenSummary(sb, ws, { since_hours: 168 }),
      attributionMetrics(sb, ws, 24),
      attributionMetrics(sb, ws, 168),
      actionDistribution(sb, ws, 24),
      actionDistribution(sb, ws, 168),
    ]);

    const tot24 = day.input_tokens + day.output_tokens;
    const tot7d = week.input_tokens + week.output_tokens;

    return {
      ...health,
      tokens_24h: {
        runs: day.runs, input: day.input_tokens, output: day.output_tokens,
        cached: day.cached_input_tokens,
        cache_rate: day.input_tokens > 0 ? +(day.cached_input_tokens / day.input_tokens).toFixed(3) : 0,
        drafted_touches: attr24.drafted_touches, scored_accounts: attr24.scored_accounts,
        tokens_per_drafted_touch: attr24.drafted_touches > 0 ? Math.round(tot24 / attr24.drafted_touches) : null,
        tokens_per_scored_account: attr24.scored_accounts > 0 ? Math.round(tot24 / attr24.scored_accounts) : null,
        action_distribution: actions24,
      },
      tokens_7d: {
        runs: week.runs, input: week.input_tokens, output: week.output_tokens,
        cached: week.cached_input_tokens,
        cache_rate: week.input_tokens > 0 ? +(week.cached_input_tokens / week.input_tokens).toFixed(3) : 0,
        drafted_touches: attr7d.drafted_touches, scored_accounts: attr7d.scored_accounts,
        tokens_per_drafted_touch: attr7d.drafted_touches > 0 ? Math.round(tot7d / attr7d.drafted_touches) : null,
        tokens_per_scored_account: attr7d.scored_accounts > 0 ? Math.round(tot7d / attr7d.scored_accounts) : null,
        action_distribution: actions7d,
      },
    };
  },
  ['health-data'],
  { revalidate: 300, tags: ['health'] },
);

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const data = await getHealthData(ws);
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'private, s-maxage=300, stale-while-revalidate=300' },
  });
}
