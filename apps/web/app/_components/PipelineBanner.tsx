'use client';

/**
 * Always-visible pipeline status at the top of every workspace page.
 *
 * Healthy: a slim muted line — when it last ran and what it produced — so the
 * operator can always see the system is alive and working.
 * Paused: a prominent amber banner with the plain-language reason (e.g. "out of
 * credit") and a Continue button. This is the "clearly show why it stopped, wait
 * for me, then let me resume" behavior — no digging through logs.
 */
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useSWR, DEFAULT_SWR } from '../_lib/swr';

interface PipelineStatus {
  state: 'ok' | 'running' | 'paused';
  reason?: string;
  provider?: string;
  paused_at?: string;
  last_run_at?: string;
  last_run?: { scanned?: number; contacts_pulled?: number; contacts_created?: number; drafts_created?: number };
}

function ago(iso?: string): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// The research dispatcher's cron always fires on the hour (0 */N * * *), so
// the next run is a deterministic wall-clock boundary — no server state needed.
function nextResearchRun(intervalHours: number): { label: string; atUtc: string } {
  const now = new Date();
  const h = now.getUTCHours();
  const addHours = intervalHours - (h % intervalHours) || intervalHours;
  const at = new Date(now);
  at.setUTCMinutes(0, 0, 0);
  at.setUTCHours(h + addHours);
  const ms = at.getTime() - now.getTime();
  const totalMin = Math.round(ms / 60000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const label = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
  const atUtc = `${String(at.getUTCHours()).padStart(2, '0')}:00 UTC`;
  return { label, atUtc };
}

function summarizeResearch(summary: any): string {
  if (!summary) return '';
  const { dispatched, due, total_evaluated } = summary;
  if (dispatched === 0 && due === 0) return `Nothing due right now (${total_evaluated ?? 0} accounts checked).`;
  return `Dispatched research for ${dispatched} account${dispatched === 1 ? '' : 's'} (${due} due).`;
}

export function PipelineBanner() {
  const params = useParams<{ ws: string }>();
  const ws = params?.ws as string | undefined;
  const { data, mutate } = useSWR<{ status: PipelineStatus | null; research_dispatch_interval_hours?: number }>(
    ws ? `/api/pipeline/status?workspace_id=${ws}` : null,
    { ...DEFAULT_SWR, refreshInterval: 20_000 },
  );
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const status = data?.status ?? null;
  const intervalHours = data?.research_dispatch_interval_hours ?? 4;
  if (!ws) return null;

  async function onContinue() {
    if (!ws) return;
    setBusy(true);
    setRunMsg(null);
    try {
      const res = await fetch('/api/pipeline/continue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws }),
      });
      const body = await res.json().catch(() => null);
      if (body?.research_summary) setRunMsg(summarizeResearch(body.research_summary));
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function onRunNow() {
    if (!ws) return;
    setBusy(true);
    setRunMsg(null);
    try {
      const res = await fetch('/api/research/run-now', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws }),
      });
      const body = await res.json().catch(() => null);
      setRunMsg(res.ok ? summarizeResearch(body?.summary) : (body?.reason ?? 'Could not start a run.'));
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  if (status?.state === 'paused') {
    return (
      <div style={{ marginBottom: '1rem' }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '.75rem', flexWrap: 'wrap',
            padding: '.6rem .9rem', borderRadius: 8,
            background: 'rgba(240, 170, 40, .12)', border: '1px solid rgba(240, 170, 40, .45)',
            color: 'var(--text)', fontSize: '.85rem',
          }}
        >
          <span style={{ fontSize: '1rem' }}>⏸</span>
          <span style={{ fontWeight: 600 }}>Paused.</span>
          <span style={{ color: 'var(--text-2)' }}>{status.reason ?? 'A provider returned an error.'}</span>
          <button
            onClick={onContinue}
            disabled={busy}
            style={{
              marginLeft: 'auto', padding: '.35rem .9rem', borderRadius: 6,
              border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff',
              fontSize: '.82rem', fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Resuming…' : 'Continue'}
          </button>
        </div>
        {runMsg && <div style={{ padding: '.3rem .1rem 0', fontSize: '.74rem', color: 'var(--text-3)' }}>{runMsg}</div>}
      </div>
    );
  }

  // Healthy / not-yet-run: one slim, low-noise line + next-run + a manual trigger.
  const lr = status?.last_run;
  const summary = status?.last_run_at
    ? `Pipeline healthy · ran ${ago(status.last_run_at)}${lr?.drafts_created != null ? ` · ${lr.drafts_created} draft${lr.drafts_created === 1 ? '' : 's'}` : ''}${lr?.contacts_created ? `, ${lr.contacts_created} contact${lr.contacts_created === 1 ? '' : 's'}` : ''}`
    : 'Pipeline hasn’t run yet.';
  const next = nextResearchRun(intervalHours);
  return (
    <div style={{ marginBottom: '.9rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.3rem .1rem', fontSize: '.74rem', color: 'var(--text-3)' }}>
        <span style={{ color: status?.last_run_at ? 'var(--accent)' : 'var(--text-3)' }}>●</span>
        <span>{summary}</span>
        <span>· next research run in {next.label} ({next.atUtc})</span>
        <button
          onClick={onRunNow}
          disabled={busy}
          style={{
            marginLeft: 'auto', padding: '.2rem .6rem', borderRadius: 6,
            border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)',
            fontSize: '.74rem', fontWeight: 500, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Running…' : 'Run research now'}
        </button>
      </div>
      {runMsg && <div style={{ padding: '0 .1rem', fontSize: '.74rem', color: 'var(--text-3)' }}>{runMsg}</div>}
    </div>
  );
}
