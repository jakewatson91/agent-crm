import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Quiet endpoint for keepalive pings (cron-job.org, UptimeRobot, etc).
// Don't route keepalives at /api/inngest — that endpoint logs an error on every
// unsigned request, which fills Render logs with false-alarm signature warnings.
export function GET() {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
