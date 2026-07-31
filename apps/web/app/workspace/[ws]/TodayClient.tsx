'use client';

/**
 * Workspace home: the full recap of the last 24 hours.
 *
 * The agent has already done the work: this page is the record of it, written
 * for a person who has five minutes and may be about to walk into a meeting.
 * Every section answers one question in plain words and links out to the place
 * where you can dig further, so nothing here is a dead end.
 *
 * Order is deliberate: what is broken, what is waiting on you, the numbers, then
 * the story (what ran, what moved, what we sent), then the raw material (what it
 * read, what it learned, who it found), then the machinery (services, sources,
 * cost, two-week trend). Approvals reuse DraftActions, so deciding here behaves
 * exactly as it does on the Feed and busts the same cache.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSWR, DEFAULT_SWR } from '../../_lib/swr';
import { DraftActions } from '../../_components/DraftActions';
import { CitedText } from '../../_components/CitedText';
import { CiteChain } from '../../_components/CiteChain';
import { WhyThis } from '../../_components/WhyThis';
import { useSetPageContext, type PageContext } from '../../_components/PageContext';
import { bandOf, BAND_HEADLINE, bandColor } from '../../_lib/bands';
import { humanizeKey } from '../../_lib/labels';
import { SCORE_DIMENSIONS } from '../../_lib/score_labels';
import { DailyBars, YieldMeter } from './TodayCharts';
import type {
  TodayData, TodayMove, TodayRun, TodaySignal, TodayLearned, TodayContact,
  TodayDraft, TodayDecline, TodayConnector, TodaySource, TodayAlert, TodayTrendPoint,
} from '../../_lib/today';
import type { FeedItem } from '../../_lib/feed_items';

interface TodayResponse {
  today: TodayData;
  needsYou: FeedItem[];
  trend: TodayTrendPoint[];
}

export function TodayClient({
  ws,
  initialToday,
  initialNeedsYou,
  initialTrend,
}: {
  ws: string;
  initialToday: TodayData;
  initialNeedsYou: FeedItem[];
  initialTrend: TodayTrendPoint[];
}) {
  const { data, mutate } = useSWR<TodayResponse>(
    `/api/today?workspace_id=${ws}`,
    { ...DEFAULT_SWR, fallbackData: { today: initialToday, needsYou: initialNeedsYou, trend: initialTrend } },
  );
  const today = data?.today ?? initialToday;
  const needsYou = data?.needsYou ?? initialNeedsYou;
  const trend = data?.trend ?? initialTrend;
  const c = today.counters;

  const pageCtx = useMemo<PageContext>(() => ({
    tab: 'today',
    summary:
      `Home briefing, last 24h: ${needsYou.length} message(s) waiting for approval, ` +
      `${c.accountsResearched} companies researched, ${c.factsLearned} facts learned, ` +
      `${today.movers.length} companies moved, ${c.draftsWritten} draft(s) written, ` +
      `${today.alerts.length} thing(s) needing attention.`,
    visible: today.movers.slice(0, 10).map((m) => ({ kind: 'account', id: m.entity_id, label: m.name })),
  }), [today, needsYou, c]);
  useSetPageContext(pageCtx);

  const sections: Array<[string, string, boolean]> = [
    ['runs', 'What ran', today.runs.length > 0],
    ['moved', 'What moved', today.movers.length > 0],
    ['outreach', 'Outreach', c.draftsWritten + c.draftsDeclined + today.decided.length > 0],
    ['read', 'What it read', today.signals.length > 0],
    ['learned', 'What it learned', today.learned.length > 0],
    ['people', 'People found', today.contacts.length > 0],
    ['system', 'System', true],
  ];

  return (
    <section style={{ maxWidth: 960 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Today</h2>
        <span className="subtle mono" suppressHydrationWarning style={{ fontSize: '.78rem' }}>{now()}</span>
        <span className="muted" style={{ fontSize: '.72rem' }}>· everything since this time yesterday</span>
      </div>

      <p style={{ marginTop: '.5rem', marginBottom: '1.25rem', fontSize: '1.02rem', lineHeight: 1.6, color: 'var(--text-2)' }}>
        <Briefing today={today} pending={needsYou.length} />
      </p>

      {today.alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginBottom: '1.5rem' }}>
          {today.alerts.map((a) => <AlertCard key={a.id} alert={a} />)}
        </div>
      )}

      {needsYou.length > 0 && (
        <ApprovalQueue items={needsYou} ws={ws} onDecided={() => mutate()} />
      )}

      <StatRow today={today} ws={ws} />

      <nav aria-label="Jump to a section" style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '1.5rem 0 1.75rem' }}>
        {sections.filter(([, , show]) => show).map(([id, label]) => (
          <a key={id} href={`#${id}`} className="jump-chip">{label}</a>
        ))}
      </nav>

      {today.runs.length > 0 && (
        <Section id="runs" title="What ran" count={today.runs.length}
          hint="Every scheduled pass in the last 24 hours, newest first.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
            {today.runs.map((r) => <RunCard key={r.id} run={r} ws={ws} />)}
          </div>
        </Section>
      )}

      {today.movers.length > 0 && (
        <Section id="moved" title="Companies that moved" count={today.movers.length + today.moversMore}
          hint="Fit scores that changed, and the new information behind each change."
          link={{ href: `/workspace/${ws}/entities`, label: 'All companies' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
            {today.movers.map((m) => <MoverCard key={m.entity_id} move={m} ws={ws} />)}
          </div>
          {today.moversMore > 0 && (
            <p className="muted" style={{ fontSize: '.78rem', marginTop: '.6rem' }}>
              {today.moversMore} more had smaller changes.
            </p>
          )}
        </Section>
      )}

      {(today.drafts.length > 0 || today.declines.length > 0 || today.decided.length > 0) && (
        <Section id="outreach" title="Outreach" count={c.draftsWritten + c.draftsDeclined}
          hint="What the agent wrote, what it refused to write and why, and what you decided."
          link={{ href: `/workspace/${ws}/feed`, label: 'Full activity' }}>
          <OutreachPanel today={today} ws={ws} />
        </Section>
      )}

      {today.signals.length > 0 && (
        <Section id="read" title="What the agent read" count={c.signals}
          hint="Every page it found, where it came from, and whether it taught us anything.">
          <ReadPanel today={today} ws={ws} />
        </Section>
      )}

      {today.learned.length > 0 && (
        <Section id="learned" title="What it learned" count={c.factsLearned}
          hint="New facts on file, by company. These are what the drafts get written from.">
          <div style={{ display: 'grid', gap: '.5rem', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {today.learned.map((l) => <LearnedCard key={l.entity_id} row={l} ws={ws} />)}
          </div>
          {today.learnedMore > 0 && (
            <p className="muted" style={{ fontSize: '.78rem', marginTop: '.6rem' }}>
              {today.learnedMore} more companies also picked up facts.
            </p>
          )}
        </Section>
      )}

      {today.contacts.length > 0 && (
        <Section id="people" title="People found" count={c.contactsFound}
          hint="New contacts, scored on how likely they are to be the right person to write to.">
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {today.contacts.map((p, i) => <ContactRow key={p.entity_id} person={p} ws={ws} first={i === 0} />)}
          </div>
        </Section>
      )}

      <Section id="system" title="System" hint="The services doing the work, what they cost, and the two-week trend.">
        <SystemPanel today={today} trend={trend} ws={ws} />
      </Section>

      <style>{`
        .jump-chip {
          font-size: .76rem; padding: .28rem .7rem; border-radius: 999px;
          border: 1px solid var(--border); background: var(--panel);
          color: var(--text-2); text-decoration: none;
        }
        .jump-chip:hover { border-color: var(--border-strong); color: var(--text); }
        .today-row { border-top: 1px solid var(--border); }
        .today-row:first-child { border-top: none; }
        .link-row:hover { background: var(--panel-2); }
      `}</style>
    </section>
  );
}

// ---------------------------------------------------------------- chrome

function now(): string {
  return new Date().toLocaleString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function money(n: number): string {
  if (n === 0) return '$0.00';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

function Num({ children }: { children: React.ReactNode }) {
  return <b style={{ color: 'var(--chart-ink)', fontWeight: 600 }}>{children}</b>;
}

function Section({
  id, title, count, hint, link, children,
}: {
  id: string; title: string; count?: number; hint?: string;
  link?: { href: string; label: string }; children: React.ReactNode;
}) {
  return (
    <div id={id} style={{ marginBottom: '2.25rem', scrollMarginTop: '1rem' }}>
      <SectionHead title={title} count={count} hint={hint} link={link} />
      {children}
    </div>
  );
}

function SectionHead({
  title, count, hint, attention, link,
}: {
  title: string; count?: number; hint?: string; attention?: boolean;
  link?: { href: string; label: string };
}) {
  return (
    <div style={{ marginBottom: '.7rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '.98rem' }}>{title}</h3>
        {count !== undefined && (
          <span
            className="mono"
            style={{
              fontSize: '.68rem', padding: '1px 8px', borderRadius: 999,
              background: attention ? 'var(--accent-amber-soft)' : 'var(--panel-2)',
              color: attention ? 'var(--badge-amber-fg)' : 'var(--text-2)',
              border: '1px solid var(--border)', fontWeight: attention ? 700 : 500,
            }}
          >
            {count}
          </span>
        )}
        {link && (
          <Link href={link.href} style={{ marginLeft: 'auto', fontSize: '.76rem' }}>{link.label} →</Link>
        )}
      </div>
      {hint && <div className="muted" style={{ fontSize: '.76rem', marginTop: '.15rem' }}>{hint}</div>}
    </div>
  );
}

function Briefing({ today, pending }: { today: TodayData; pending: number }) {
  const c = today.counters;
  const co = (n: number) => (n === 1 ? 'company' : 'companies');
  const approval =
    pending === 0
      ? <>Nothing needs your approval right now.</>
      : <><Num>{pending}</Num> {pending === 1 ? 'message is' : 'messages are'} waiting on your yes or no.</>;

  if (c.accountsResearched === 0 && c.signals === 0 && c.contactsFound === 0) {
    return (
      <>
        {today.pipeline.paused
          ? <>The agent is paused, so nothing new came in. </>
          : <>Quiet stretch. No new research landed in the last 24 hours. </>}
        {approval}
      </>
    );
  }

  return (
    <>
      In the last 24 hours the agent read <Num>{c.signals}</Num> pages about{' '}
      <Num>{c.accountsResearched}</Num> {co(c.accountsResearched)}, learned <Num>{c.factsLearned}</Num> new{' '}
      {c.factsLearned === 1 ? 'fact' : 'facts'}
      {c.painsFound > 0 && <> (<Num>{c.painsFound}</Num> of them a problem worth selling into)</>},
      {' '}and re-scored <Num>{c.accountsScored}</Num> {co(c.accountsScored)}
      {c.scoreUp > 0 && <>, of which <Num>{c.scoreUp}</Num> got better {c.scoreDown > 0 && <>and <Num>{c.scoreDown}</Num> got worse</>}</>}
      . It found <Num>{c.contactsFound}</Num> {c.contactsFound === 1 ? 'person' : 'people'} to write to,
      wrote <Num>{c.draftsWritten}</Num> {c.draftsWritten === 1 ? 'message' : 'messages'} and passed on{' '}
      <Num>{c.draftsDeclined}</Num>. It spent <Num>{money(c.spendUsd)}</Num> doing it. {approval}
    </>
  );
}

function AlertCard({ alert }: { alert: TodayAlert }) {
  const red = alert.severity === 'red';
  return (
    <div
      className="card"
      style={{
        padding: '.75rem 1rem', display: 'flex', gap: '.7rem', alignItems: 'flex-start',
        borderColor: red ? 'var(--accent-coral)' : 'var(--accent-amber)',
        background: red ? 'var(--accent-coral-soft)' : 'var(--accent-amber-soft)',
      }}
    >
      <span className={`badge ${red ? 'badge-coral' : 'badge-amber'}`} style={{ flexShrink: 0, marginTop: 1 }}>
        {red ? 'blocked' : 'check'}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '.9rem', color: 'var(--text)' }}>{alert.title}</div>
        <div style={{ fontSize: '.83rem', color: 'var(--text-2)', marginTop: '.15rem' }}>{alert.detail}</div>
      </div>
      {alert.href && (
        <Link href={alert.href} style={{ fontSize: '.8rem', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {alert.hrefLabel} →
        </Link>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- numbers

function StatRow({ today, ws }: { today: TodayData; ws: string }) {
  const c = today.counters;
  const tiles: Array<{ label: string; value: string; sub: string; href?: string }> = [
    { label: 'Pages read', value: String(c.signals), sub: `${c.accountsResearched} companies · ${c.searches} searches`, href: '#read' },
    { label: 'Facts learned', value: String(c.factsLearned), sub: c.painsFound > 0 ? `${c.painsFound} named a real problem` : c.factsLearned > 0 ? 'across the book' : 'nothing new yet', href: '#learned' },
    { label: 'Scores moved', value: String(c.scoreUp + c.scoreDown), sub: `${c.scoreUp} up · ${c.scoreDown} down · ${c.accountsScored} checked`, href: '#moved' },
    { label: 'People found', value: String(c.contactsFound), sub: `${c.contactPulls} companies tried`, href: '#people' },
    { label: 'Messages', value: String(c.draftsWritten), sub: `${c.draftsDeclined} passed on · ${c.approvalsPending} waiting`, href: '#outreach' },
    { label: 'Spend', value: money(c.spendUsd), sub: 'today, model + search', href: '#system' },
  ];
  return (
    <div style={{ display: 'grid', gap: '.6rem', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))' }}>
      {tiles.map((t) => (
        <a key={t.label} href={t.href} className="card link-row" style={{ padding: '.7rem .85rem', textDecoration: 'none', display: 'block' }}>
          <div className="muted" style={{ fontSize: '.72rem' }}>{t.label}</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)', lineHeight: 1.15, margin: '.1rem 0' }}>{t.value}</div>
          <div className="muted" style={{ fontSize: '.7rem' }}>{t.sub}</div>
        </a>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- runs

const RUN_TONE: Record<TodayRun['kind'], string> = {
  research: 'badge-blue',
  outreach: 'badge-green',
  domains: 'badge-purple',
  maintenance: 'badge-mute',
};

function RunCard({ run, ws }: { run: TodayRun; ws: string }) {
  const sameMinute = run.startedAt.slice(0, 16) === run.endedAt.slice(0, 16);
  return (
    <div className="card" style={{ padding: '.75rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
        <span className="mono" suppressHydrationWarning style={{ fontSize: '.76rem', color: 'var(--text-2)', minWidth: 92 }}>
          {clock(run.startedAt)}{!sameMinute && ` – ${clock(run.endedAt)}`}
        </span>
        <span style={{ fontWeight: 600, fontSize: '.9rem', color: 'var(--text)' }}>{run.label}</span>
        <span className={`badge ${run.ok ? RUN_TONE[run.kind] : 'badge-coral'}`}>{run.ok ? run.kind : 'had errors'}</span>
        <span className="muted" suppressHydrationWarning style={{ fontSize: '.72rem', marginLeft: 'auto' }}>{ago(run.startedAt)}</span>
      </div>

      <div style={{ display: 'flex', gap: '1.1rem', flexWrap: 'wrap', margin: '.55rem 0 0' }}>
        {run.stats.map((s) => (
          <span key={s.label} style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
            <b style={{ color: s.value === '0' ? 'var(--text-3)' : 'var(--text)', fontWeight: 600 }}>{s.value}</b> {s.label}
          </span>
        ))}
      </div>

      {run.accounts.length > 0 && (
        <div style={{ marginTop: '.5rem', display: 'flex', gap: '.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {run.accounts.map((a) => (
            <Link key={a.id} href={`/workspace/${ws}/entities/${a.id}`} className="chip">
              {a.name}
            </Link>
          ))}
          {run.accountsMore > 0 && <span className="muted" style={{ fontSize: '.72rem' }}>+{run.accountsMore} more</span>}
        </div>
      )}

      {run.errors.map((e) => (
        <div key={e} style={{ marginTop: '.5rem', fontSize: '.78rem', color: 'var(--badge-coral-fg)', background: 'var(--accent-coral-soft)', border: '1px solid var(--border)', borderRadius: 6, padding: '.35rem .55rem' }}>
          {e}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- movers

function ScoreShift({ prev, next }: { prev: number | null; next: number }) {
  const nb = bandOf(next);
  const color = bandColor(next);
  const headline = BAND_HEADLINE[nb].toLowerCase();
  if (prev === null) {
    return (
      <span className="mono" style={{ fontSize: '.74rem' }}>
        <span className="muted">new →</span> <b style={{ color }}>{headline}</b>
      </span>
    );
  }
  const pb = bandOf(prev);
  const arrow = next > prev ? '↑' : next < prev ? '↓' : '·';
  return (
    <span className="mono" style={{ fontSize: '.74rem' }}>
      {pb !== nb && <><span className="muted">{BAND_HEADLINE[pb].toLowerCase()} →</span>{' '}</>}
      <b style={{ color }}>{headline}</b>{' '}
      <span className="muted">{arrow} {prev.toFixed(2)}→{next.toFixed(2)}</span>
    </span>
  );
}

function MoverCard({ move, ws }: { move: TodayMove; ws: string }) {
  return (
    <div className="card" style={{ padding: '.85rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.55rem', flexWrap: 'wrap' }}>
        <Link href={`/workspace/${ws}/entities/${move.entity_id}`} style={{ fontWeight: 600, color: 'var(--text)' }}>
          {move.name}
        </Link>
        <ScoreShift prev={move.scorePrev} next={move.scoreNew} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '.3rem' }}>
          {move.hasContact && <span className="badge badge-mute">person found</span>}
          {move.hasDraft && <span className="badge badge-green">message drafted</span>}
        </span>
      </div>

      {move.driver && (
        <div style={{ fontSize: '.79rem', color: 'var(--text-2)', marginTop: '.35rem' }}>
          Moved on <b style={{ color: 'var(--text)' }}>{(SCORE_DIMENSIONS[move.driver.key]?.label ?? humanizeKey(move.driver.key)).toLowerCase()}</b>
          {' '}<span className="mono muted">{move.driver.prev.toFixed(2)} → {move.driver.next.toFixed(2)}</span>
          {SCORE_DIMENSIONS[move.driver.key] && <span className="muted"> · {SCORE_DIMENSIONS[move.driver.key]!.help}</span>}
          {move.driver.fact_ids && move.driver.fact_ids.length > 0 && (
            <span style={{ marginLeft: '.4rem', display: 'inline-flex', gap: '.25rem' }}>
              {move.driver.fact_ids.map((id) => <CiteChain key={id} fact_id={id} label="trace" />)}
            </span>
          )}
        </div>
      )}

      {move.claim && (
        <div style={{ marginTop: '.45rem' }}>
          <div style={{ display: 'flex', gap: '.45rem', alignItems: 'baseline' }}>
            <span className="badge badge-blue" style={{ flexShrink: 0 }}>new info</span>
            <span style={{ fontSize: '.88rem', color: 'var(--text-2)', lineHeight: 1.5 }}>{move.claim.body}</span>
          </div>
          <div style={{ marginTop: '.3rem' }}>
            <WhyThis
              postId={move.claim.post_id}
              workspace_id={ws}
              entity_id={move.entity_id}
              ts={move.claim.created_at}
              reasoning={null}
              cites={move.claim.cites}
            />
          </div>
        </div>
      )}

      {!move.claim && move.reasoning && (
        <div style={{ fontSize: '.85rem', color: 'var(--text-2)', marginTop: '.35rem', lineHeight: 1.5 }}>{move.reasoning}</div>
      )}

      {move.facts.length > 0 && (
        <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          {move.facts.map((f) => (
            <div key={f.id}>
              <span className="chip" title={f.object}>
                {humanizeKey(f.predicate)}: {f.object.length > 42 ? `${f.object.slice(0, 42)}…` : f.object}
              </span>
              <div style={{ marginTop: '.15rem' }}>
                <CiteChain fact_id={f.id} label="trace" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- outreach

function OutreachPanel({ today, ws }: { today: TodayData; ws: string }) {
  const [showAllDeclines, setShowAllDeclines] = useState(false);
  const declines = showAllDeclines ? today.declines : today.declines.slice(0, 4);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {today.drafts.length > 0 && (
        <div>
          <div className="subtle" style={{ fontSize: '.8rem', marginBottom: '.4rem' }}>Written</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
            {today.drafts.map((d) => <DraftRow key={d.post_id} draft={d} ws={ws} />)}
          </div>
        </div>
      )}

      {today.decided.length > 0 && (
        <div>
          <div className="subtle" style={{ fontSize: '.8rem', marginBottom: '.4rem' }}>Your decisions</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {today.decided.map((d, i) => (
              <div key={`${d.entity_name}-${d.at}`} className="today-row" style={{ display: 'flex', gap: '.6rem', alignItems: 'center', padding: '.5rem .85rem', fontSize: '.84rem' }}>
                <span className={`badge ${d.decision === 'approve' ? 'badge-green' : 'badge-coral'}`}>{d.decision === 'approve' ? 'approved' : d.decision}</span>
                <span style={{ color: 'var(--text)' }}>{d.entity_name}</span>
                {d.edited && <span className="badge badge-mute">you edited it first</span>}
                <span className="muted" suppressHydrationWarning style={{ marginLeft: 'auto', fontSize: '.74rem' }}>{clock(d.at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {today.declines.length > 0 && (
        <div>
          <div className="subtle" style={{ fontSize: '.8rem', marginBottom: '.4rem' }}>
            Passed on, and what it is waiting for
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {declines.map((d, i) => <DeclineRow key={`${d.entity_id}-${d.at}-${i}`} row={d} ws={ws} />)}
          </div>
          {today.declines.length > 4 && (
            <button
              onClick={() => setShowAllDeclines((v) => !v)}
              style={{ marginTop: '.45rem', background: 'none', border: 'none', color: 'var(--link)', fontSize: '.78rem', padding: 0 }}
            >
              {showAllDeclines ? 'Show fewer' : `Show all ${today.declines.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DraftRow({ draft, ws }: { draft: TodayDraft; ws: string }) {
  return (
    <div className="card" style={{ padding: '.75rem .95rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.4rem', flexWrap: 'wrap' }}>
        <Link href={`/workspace/${ws}/entities/${draft.entity_id}`} style={{ fontWeight: 600, color: 'var(--text)', fontSize: '.9rem' }}>
          {draft.entity_name}
        </Link>
        <span className={`badge ${draft.pending ? 'badge-amber' : 'badge-mute'}`}>
          {draft.pending ? 'waiting on you' : 'decided'}
        </span>
        <span className="muted" suppressHydrationWarning style={{ marginLeft: 'auto', fontSize: '.74rem' }}>{clock(draft.createdAt)}</span>
      </div>
      <div style={{
        fontSize: '.84rem', color: 'var(--text-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
        background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '.6rem .75rem',
      }}>
        {draft.cites.length > 0 ? <CitedText text={draft.body} cites={draft.cites} citeQuotes={draft.cite_quotes} /> : draft.body}
      </div>
      {draft.cites.length > 0 && (
        <div style={{ marginTop: '.4rem' }}>
          <WhyThis
            postId={draft.post_id}
            workspace_id={ws}
            entity_id={draft.entity_id}
            ts={draft.createdAt}
            reasoning={draft.reasoning}
            cites={draft.cites}
          />
        </div>
      )}
    </div>
  );
}

function DeclineRow({ row, ws }: { row: TodayDecline; ws: string }) {
  return (
    <div className="today-row" style={{ padding: '.55rem .85rem' }}>
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Link href={`/workspace/${ws}/entities/${row.entity_id}`} style={{ fontSize: '.86rem', fontWeight: 500, color: 'var(--text)' }}>
          {row.entity_name}
        </Link>
        {row.tag && <span className="badge badge-mute">{humanizeKey(row.tag).toLowerCase()}</span>}
        <span className="muted" suppressHydrationWarning style={{ marginLeft: 'auto', fontSize: '.72rem' }}>{clock(row.at)}</span>
      </div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: '.15rem', lineHeight: 1.45 }}>{row.reason}</div>
    </div>
  );
}

// ---------------------------------------------------------------- what it read

const OUTCOME_LABEL: Record<TodaySignal['outcome'], { text: string; cls: string }> = {
  facts: { text: 'taught us something', cls: 'badge-green' },
  nothing_new: { text: 'nothing new', cls: 'badge-mute' },
  duplicate: { text: 'skipped as repeat', cls: 'badge-mute' },
  unread: { text: 'queued', cls: 'badge-blue' },
};

function ReadPanel({ today, ws }: { today: TodayData; ws: string }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? today.signals : today.signals.slice(0, 8);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {today.signalAngles.length > 0 && (
        <div className="card" style={{ padding: '.85rem 1rem' }}>
          <div className="subtle" style={{ fontSize: '.8rem', marginBottom: '.5rem' }}>
            What each line of search turned up
          </div>
          {today.signalAngles.map((a) => (
            <YieldMeter
              key={a.angle}
              label={humanizeKey(a.angle)}
              value={a.withFacts}
              total={a.count}
              caption={`${a.withFacts} of ${a.count} useful`}
            />
          ))}
          <div className="muted" style={{ fontSize: '.72rem', marginTop: '.5rem' }}>
            The bar is the share of pages that produced at least one new fact. A low share means that
            angle is spending searches for little return.
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.map((s) => <SignalRow key={s.id} sig={s} ws={ws} />)}
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        {today.signals.length > 8 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--link)', fontSize: '.78rem', padding: 0 }}
          >
            {showAll ? 'Show fewer' : `Show all ${today.signals.length} listed`}
          </button>
        )}
        {today.signalsMore > 0 && (
          <span className="muted" style={{ fontSize: '.76rem' }}>
            {today.signalsMore} more read but not listed here.
          </span>
        )}
      </div>
    </div>
  );
}

function SignalRow({ sig, ws }: { sig: TodaySignal; ws: string }) {
  const out = OUTCOME_LABEL[sig.outcome];
  return (
    <div className="today-row" style={{ padding: '.6rem .85rem' }}>
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        {sig.entity_id
          ? <Link href={`/workspace/${ws}/entities/${sig.entity_id}`} style={{ fontSize: '.85rem', fontWeight: 500, color: 'var(--text)' }}>{sig.entity_name}</Link>
          : <span style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>{sig.entity_name}</span>}
        <span className="badge badge-mute">{humanizeKey(sig.angle)}</span>
        <span className={`badge ${out.cls}`}>{sig.factCount > 0 ? `${sig.factCount} facts` : out.text}</span>
        <span className="muted" suppressHydrationWarning style={{ marginLeft: 'auto', fontSize: '.72rem' }}>{clock(sig.createdAt)}</span>
      </div>
      <div style={{ fontSize: '.84rem', color: 'var(--text)', marginTop: '.2rem' }}>
        {sig.url
          ? <a href={sig.url} target="_blank" rel="noopener noreferrer">{sig.title || sig.url}</a>
          : (sig.title || 'untitled page')}
      </div>
      {sig.snippet && (
        <div className="muted" style={{ fontSize: '.79rem', marginTop: '.1rem', lineHeight: 1.45 }}>{sig.snippet}</div>
      )}
      <div className="muted" style={{ fontSize: '.7rem', marginTop: '.25rem' }}>
        {sig.url ? new URL(sig.url).hostname.replace(/^www\./, '') : 'no link'}
        {sig.publishedAt && <> · published {sig.publishedAt.slice(0, 10)}</>}
        {sig.magnitude !== null && <> · strength {sig.magnitude.toFixed(2)}</>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- learned

function LearnedCard({ row, ws }: { row: TodayLearned; ws: string }) {
  return (
    <div className="card" style={{ padding: '.7rem .9rem' }}>
      <Link href={`/workspace/${ws}/entities/${row.entity_id}`} style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--text)' }}>
        {row.name}
      </Link>
      <div style={{ marginTop: '.4rem', display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        {row.facts.map((f) => (
          <div key={f.id} style={{ fontSize: '.82rem', lineHeight: 1.4 }}>
            <span className={`badge ${f.pain ? 'badge-coral' : 'badge-mute'}`} style={{ marginRight: '.35rem' }}>
              {f.pain ? 'problem' : humanizeKey(f.predicate)}
            </span>
            <span style={{ color: 'var(--text-2)' }}>{f.object}</span>
            <span style={{ marginLeft: '.4rem' }}>
              <CiteChain fact_id={f.id} label="trace" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- people

function ContactRow({ person, ws, first }: { person: TodayContact; ws: string; first: boolean }) {
  return (
    <div className={first ? '' : 'today-row'} style={{ display: 'flex', gap: '.6rem', alignItems: 'baseline', flexWrap: 'wrap', padding: '.55rem .85rem' }}>
      <Link href={`/workspace/${ws}/entities/${person.entity_id}`} style={{ fontSize: '.86rem', fontWeight: 500, color: 'var(--text)' }}>
        {person.name}
      </Link>
      {person.role && <span style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>{person.role}</span>}
      {person.account_name && person.account_id && (
        <Link href={`/workspace/${ws}/entities/${person.account_id}`} className="chip">
          {person.account_name}
        </Link>
      )}
      {person.email && <span className="mono muted" style={{ fontSize: '.74rem' }}>{person.email}</span>}
      {person.score !== null && (
        <span className="mono" style={{ marginLeft: 'auto', fontSize: '.74rem', color: bandColor(person.score) }}>
          {BAND_HEADLINE[bandOf(person.score)].toLowerCase()}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- system

function SystemPanel({ today, trend, ws }: { today: TodayData; trend: TodayTrendPoint[]; ws: string }) {
  const s = today.spend;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="card" style={{ padding: '.9rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', marginBottom: '.7rem' }}>
          <span className="subtle" style={{ fontSize: '.8rem' }}>Last two weeks</span>
          <Link href={`/workspace/${ws}/replay`} style={{ marginLeft: 'auto', fontSize: '.76rem' }}>Replay any day →</Link>
        </div>
        <div style={{ display: 'grid', gap: '1.4rem', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
          <DailyBars title="Pages read" unit="pages" points={trend.map((p) => ({ day: p.day, value: p.signals }))} />
          <DailyBars title="Companies scored" unit="companies" points={trend.map((p) => ({ day: p.day, value: p.scored }))} />
          <DailyBars title="Messages written" unit="messages" points={trend.map((p) => ({ day: p.day, value: p.drafts }))} />
        </div>
        <div className="muted" style={{ fontSize: '.72rem', marginTop: '.6rem' }}>
          Days here are UTC calendar days, so the last bar is a partial day and will not match the
          rolling 24-hour numbers at the top of the page.
        </div>
      </div>

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card" style={{ padding: '.9rem 1rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '.5rem' }}>
            <span className="subtle" style={{ fontSize: '.8rem' }}>Connected services</span>
            <Link href={`/workspace/${ws}/settings/connectors`} style={{ marginLeft: 'auto', fontSize: '.76rem' }}>Manage →</Link>
          </div>
          {today.connectors.map((c) => <ConnectorLine key={c.id} conn={c} />)}
        </div>

        <div className="card" style={{ padding: '.9rem 1rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '.5rem' }}>
            <span className="subtle" style={{ fontSize: '.8rem' }}>Where new companies come from</span>
            <Link href={`/workspace/${ws}/sources`} style={{ marginLeft: 'auto', fontSize: '.76rem' }}>Sources →</Link>
          </div>
          {today.sources.length === 0 && (
            <div className="muted" style={{ fontSize: '.8rem' }}>No sources set up. The agent only works on companies you import.</div>
          )}
          {today.sources.map((src) => <SourceLine key={src.id} src={src} />)}
        </div>
      </div>

      <div className="card" style={{ padding: '.9rem 1rem' }}>
        <div className="subtle" style={{ fontSize: '.8rem', marginBottom: '.55rem' }}>What today cost</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', marginBottom: '.6rem' }}>
          <span style={{ fontSize: '1.6rem', fontWeight: 600 }}>{money(s.totalUsd)}</span>
          <span className="muted" style={{ fontSize: '.78rem' }}>
            ≈ {money(s.perDayUsd * 30)} a month at this pace
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          {s.byModel.map((m) => (
            <div key={m.model} style={{ display: 'flex', gap: '.5rem', fontSize: '.8rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="mono" style={{ color: 'var(--text)' }}>{m.model}</span>
              <span className="muted">{m.behaviors.join(', ')} · {m.runs} calls · {(m.input / 1000).toFixed(0)}k in / {(m.output / 1000).toFixed(0)}k out</span>
              <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>{m.usd === null ? 'no rate set' : money(m.usd)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: '.5rem', fontSize: '.8rem', alignItems: 'baseline' }}>
            <span className="mono" style={{ color: 'var(--text)' }}>web search</span>
            <span className="muted">{s.exa.searches} searches incl. page fetches</span>
            <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>{money(s.exa.usd)}</span>
          </div>
        </div>
        <div className="muted" style={{ fontSize: '.72rem', marginTop: '.55rem' }}>
          Model cost is a floor: only the steps that record token counts are included. Rates are the
          providers&apos; list prices and can be overridden in workspace settings.
        </div>
      </div>
    </div>
  );
}

function ConnectorLine({ conn }: { conn: TodayConnector }) {
  const tone = conn.health === 'error' ? 'badge-coral' : conn.health === 'connected' ? 'badge-green' : 'badge-mute';
  const label = conn.health === 'error' ? 'problem' : conn.health === 'connected' ? 'connected' : 'not set up';
  return (
    <div className="today-row" style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', padding: '.4rem 0', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '.85rem', color: 'var(--text)' }}>{conn.name}</span>
      <span className={`badge ${tone}`}>{label}</span>
      {conn.role && <span className="badge badge-mute">{conn.role}</span>}
      <span className="muted" style={{ marginLeft: 'auto', fontSize: '.74rem', textAlign: 'right' }}>
        {conn.alert ?? conn.usage ?? (conn.health === 'connected' ? 'idle today' : `needs ${conn.missing.join(', ')}`)}
      </span>
    </div>
  );
}

function SourceLine({ src }: { src: TodaySource }) {
  const tone = !src.active ? 'badge-mute' : src.status && src.status !== 'ok' ? 'badge-coral' : src.overdue ? 'badge-amber' : 'badge-green';
  const label = !src.active ? 'off' : src.status && src.status !== 'ok' ? 'failed' : src.overdue ? 'behind schedule' : 'on schedule';
  return (
    <div className="today-row" style={{ padding: '.4rem 0' }}>
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '.85rem', color: 'var(--text)' }}>{src.name}</span>
        <span className={`badge ${tone}`}>{label}</span>
        <span className="muted" suppressHydrationWarning style={{ marginLeft: 'auto', fontSize: '.74rem' }}>ran {ago(src.lastRunAt)}</span>
      </div>
      <div className="muted" style={{ fontSize: '.74rem' }}>
        {/* signals_7d is a snapshot taken when the source last ran, not a live
            count, so it must not be labelled "in the last 7 days". */}
        Last run: {src.summary}{src.signals7d > 0 && <> · {src.signals7d} in the week up to that run</>}
      </div>
      {src.error && (
        <div style={{ fontSize: '.74rem', color: 'var(--badge-coral-fg)' }}>{src.error}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- approvals

/**
 * A backlog of approvals is real information, but 28 full drafts stacked above
 * the fold buries everything else the page has to say. Show a handful, keep the
 * true count in the header, and let the reader open the rest in place.
 */
const APPROVALS_SHOWN = 5;

function ApprovalQueue({ items, ws, onDecided }: { items: FeedItem[]; ws: string; onDecided: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, APPROVALS_SHOWN);
  return (
    <div style={{ marginBottom: '2rem' }}>
      <SectionHead title="Waiting on you" count={items.length} attention
        hint="The agent will not send these until you say yes." />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
        {shown.map((it) => (
          <ApprovalCard key={it.id} item={it} ws={ws} onDecided={onDecided} />
        ))}
      </div>
      {items.length > APPROVALS_SHOWN && (
        <button
          onClick={() => setShowAll((v) => !v)}
          style={{ marginTop: '.6rem', background: 'none', border: 'none', color: 'var(--link)', fontSize: '.8rem', padding: 0 }}
        >
          {showAll ? 'Show fewer' : `Show all ${items.length} waiting`}
        </button>
      )}
    </div>
  );
}

function ApprovalCard({ item, ws, onDecided }: { item: FeedItem; ws: string; onDecided: () => void }) {
  return (
    <div className="card" style={{ padding: '.95rem 1.1rem', borderColor: 'var(--accent-amber)' }}>
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
        {item.cites.length > 0 ? <CitedText text={item.body} cites={item.cites} citeQuotes={item.cite_quotes} /> : item.body}
      </div>
      <DraftActions postId={item.id} workspaceId={ws} initialGate={item.gate} onDecided={onDecided} />
    </div>
  );
}
