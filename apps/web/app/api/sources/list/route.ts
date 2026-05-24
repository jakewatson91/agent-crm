import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getSourceMetrics } from '@agent-crm/tools/source_metrics';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  // window controls the rollup attached to each source row. Default 7d gives
  // the operator enough sample size on most sources to read trends.
  const window_hours = Number(url.searchParams.get('window_hours') ?? '168') || 168;

  const supabase = createServerClient();
  const [srcRes, metrics] = await Promise.all([
    supabase
      .from('sources')
      .select('id, connector_type, name, config, schedule_cron, active, last_run_at, last_run_status, last_run_summary, created_at')
      .eq('workspace_id', workspace_id)
      .order('created_at', { ascending: false }),
    getSourceMetrics(supabase, workspace_id, window_hours).catch((e) => {
      console.error('source_metrics failed:', e?.message ?? e);
      return [];
    }),
  ]);
  if (srcRes.error) return NextResponse.json({ error: srcRes.error.message }, { status: 500 });
  const metricsById = new Map(metrics.map((m) => [m.source_id, m]));
  const sources = (srcRes.data ?? []).map((s) => ({ ...s, metrics: metricsById.get(s.id) ?? null }));
  return NextResponse.json({ sources, window_hours });
}
