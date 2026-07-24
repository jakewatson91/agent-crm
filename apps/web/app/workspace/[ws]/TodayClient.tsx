'use client';

/**
 * Workspace home: the agent's daily briefing. Not a dashboard of charts — a
 * short written summary of what the agent did, the approvals waiting on you,
 * and the accounts that moved and why. Data + story come from the same place
 * as the digest email (see app/_lib/today.ts).
 *
 * The approval cards reuse DraftActions, so accepting/editing/rejecting here
 * behaves identically to the Feed and busts the same 60s cache.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useSWR, DEFAULT_SWR } from '../../_lib/swr';
import { DraftActions } from '../../_components/DraftActions';
import { CitedText } from '../../_components/CitedText';
import { useSetPageContext, type PageContext } from '../../_components/PageContext';
import { bandOf, BAND_HEADLINE, bandColor } from '../../_lib/bands';
import type { TodayData, TodayMove } from '../../_lib/today';
import type { FeedItem } from '../../_lib/feed_items';

interface TodayResponse {
  today: TodayData;
  needsYou: FeedItem[];
}

export function TodayClient({
  ws,
  initialToday,
  initialNeedsYou,
}: {
  ws: string;
  initialToday: TodayData;
  initialNeedsYou: FeedItem[];
}) {
  const { data, mutate } = useSWR<TodayResponse>(
    `/api/today?workspace_id=${ws}`,
    { ...DEFAULT_SWR, fallbackData: { today: initialToday, needsYou: initialNeedsYou } },
  );
  const today = data?.today ?? initialToday;
  const needsYou = data?.needsYou ?? initialNeedsYou;

  const pageCtx = useMemo<PageContext>(() => ({
    tab: 'today',
    summary: `Home briefing: ${needsYou.length} approval(s) waiting, ${today.moved.length} account(s) moved in the ${today.windowLabel}.`,
    visible: today.moved.slice(0, 10).map((m) => ({ kind: 'account', id: m.entity_id, label: m.name })),
  }), [today, needsYou]);
  useSetPageContext(pageCtx);

  const nothing = needsYou.length === 0 && today.moved.length === 0;

  return (
    <section style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', flexWrap: 'wrap', marginBottom: '.2rem' }}>
        <h2 style={{ margin: 0 }}>Today</h2>
        <span className="subtle mono" style={{ fontSize: '.78rem' }}>{now()}</span>
      </div>

      <p className="agent-voice" style={{ marginTop: '.5rem', marginBottom: '2rem' }}>
        <Briefing today={today} pending={needsYou.length} />
      </p>

      {nothing ? (
        <div className="card" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-3)', fontSize: '.9rem' }}>
          All quiet. Nothing needs you right now — the agent keeps researching and will surface anything that moves here.
        </div>
      ) : (
        <>
          {needsYou.length > 0 && (
            <div style={{ marginBottom: '2rem' }}>
              <SectionHead title="Needs you" count={needsYou.length} attention />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                {needsYou.map((it) => (
                  <ApprovalCard key={it.id} item={it} ws={ws} onDecided={() => mutate()} />
                ))}
              </div>
            </div>
          )}

          {today.moved.length > 0 && (
            <div>
              <SectionHead title="Moved today" count={today.moved.length} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
                {today.moved.map((m) => (
                  <MovedCard key={m.entity_id} move={m} ws={ws} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function now(): string {
  return new Date().toLocaleString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function Num({ children }: { children: React.ReactNode }) {
  return <b style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>{children}</b>;
}

function Briefing({ today, pending }: { today: TodayData; pending: number }) {
  const paused = today.pipelineStatus.startsWith('paused');
  const co = (n: number) => (n === 1 ? 'company' : 'companies');
  const movedPhrase =
    today.moved.length === 0
      ? <>nothing moved enough to flag</>
      : <>{' '}<Num>{today.moved.length}</Num> of them moved</>;
  const approvalPhrase =
    pending === 0
      ? <>Nothing needs your approval right now.</>
      : <><Num>{pending}</Num> {pending === 1 ? 'message is' : 'messages are'} ready for your approval below.</>;

  if (today.researched === 0 && today.signals === 0) {
    return (
      <>
        {paused ? <>The agent is paused right now. </> : <>Quiet stretch — no new research landed in the {today.windowLabel}. </>}
        {approvalPhrase}
      </>
    );
  }

  return (
    <>
      Over the {today.windowLabel}, I researched <Num>{today.researched}</Num> {co(today.researched)} and {movedPhrase}. {approvalPhrase}
      {paused && <> The pipeline is paused — see the notice above.</>}
    </>
  );
}

function SectionHead({ title, count, attention }: { title: string; count: number; attention?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.7rem' }}>
      <h3 style={{ margin: 0, fontSize: '.98rem' }}>{title}</h3>
      <span
        className="mono"
        style={{
          fontSize: '.68rem', padding: '1px 8px', borderRadius: 999,
          background: attention ? 'var(--accent-amber-soft)' : 'var(--panel-2)',
          color: attention ? '#a9761a' : 'var(--text-2)',
          border: '1px solid var(--border)',
          fontWeight: attention ? 700 : 500,
        }}
      >
        {count}
      </span>
    </div>
  );
}

function ScoreShift({ prev, next }: { prev: number | null; next: number }) {
  const nb = bandOf(next);
  const headline = BAND_HEADLINE[nb];
  const color = bandColor(next);
  if (prev === null) {
    return (
      <span className="mono" style={{ fontSize: '.74rem' }}>
        <span className="muted">new</span> <span className="muted">→</span>{' '}
        <b style={{ color }}>{headline.toLowerCase()}</b>
      </span>
    );
  }
  const pb = bandOf(prev);
  if (pb === nb) {
    return (
      <span className="mono" style={{ fontSize: '.74rem' }}>
        <b style={{ color }}>{headline.toLowerCase()}</b> <span className="muted">· steady</span>
      </span>
    );
  }
  return (
    <span className="mono" style={{ fontSize: '.74rem' }}>
      <span className="muted">{BAND_HEADLINE[pb].toLowerCase()}</span> <span className="muted">→</span>{' '}
      <b style={{ color }}>{headline.toLowerCase()}</b>
    </span>
  );
}

function MovedCard({ move, ws }: { move: TodayMove; ws: string }) {
  return (
    <Link href={`/workspace/${ws}/entities/${move.entity_id}`} style={{ textDecoration: 'none' }}>
      <div className="card move-card" style={{ padding: '.85rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.55rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{move.name}</span>
          <ScoreShift prev={move.scorePrev} next={move.scoreNew} />
        </div>
        <div className="agent-voice" style={{ fontSize: '.92rem', color: 'var(--text-2)', marginTop: '.3rem', lineHeight: 1.5 }}>
          {move.why}
        </div>
      </div>
    </Link>
  );
}

function ApprovalCard({ item, ws, onDecided }: { item: FeedItem; ws: string; onDecided: () => void }) {
  return (
    <div className="card" style={{ padding: '.95rem 1.1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.55rem', flexWrap: 'wrap', marginBottom: '.55rem' }}>
        <Link href={`/workspace/${ws}/entities/${item.entity_id}`} style={{ fontWeight: 600, color: 'var(--text)', fontSize: '.95rem' }}>
          {item.entity_name}
        </Link>
        <span className="badge badge-green">outreach</span>
        {item.icp_fit !== null && (
          <span className="mono" style={{ fontSize: '.72rem', color: bandColor(item.icp_fit) }}>
            {BAND_HEADLINE[bandOf(item.icp_fit)].toLowerCase()}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: '.86rem', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.55,
          fontFamily: 'var(--font-mono)', background: 'var(--panel-2)',
          border: '1px solid var(--border)', borderRadius: 8, padding: '.7rem .85rem',
        }}
      >
        {item.cites.length > 0 ? <CitedText text={item.body} cites={item.cites} /> : item.body}
      </div>
      <DraftActions postId={item.id} workspaceId={ws} initialGate={item.gate} onDecided={onDecided} />
    </div>
  );
}
