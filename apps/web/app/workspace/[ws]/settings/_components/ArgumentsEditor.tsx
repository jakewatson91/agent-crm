'use client';

import { useEffect, useRef, useState } from 'react';
import type { DrafterArgument } from '@agent-crm/tools';

/**
 * Edit the arguments this workspace makes, and decide whether one is allowed to
 * run on the whole book.
 *
 * Every other derived field is a component of a message. This is the reason to
 * send one, and until it existed the drafter worked the reason out fresh on
 * every message from a paragraph describing how the product works. That is how
 * one workspace sent 26 messages making the same wrong offer.
 *
 * The decision is the screen; the text boxes are behind it. An argument the
 * wizard guessed has never met a real account, so the drafter writes three
 * messages under it and stops, and a human then says yes or no to those three.
 * The first version of this screen had that backwards: four text boxes on top,
 * the three messages hidden behind a button, and the decision itself a checkbox
 * at the bottom of a settings form. You cannot judge an argument by reading its
 * config. You judge it by reading what it wrote, so that goes first and the
 * wording opens only when you want to change it.
 */

const FIELDS: Array<{
  key: 'when' | 'only_if' | 'so' | 'ask';
  label: string;
  help: string;
  example: string;
}> = [
  {
    key: 'when',
    label: 'When',
    help: 'The event at their company that makes this worth sending. Has to be findable from outside.',
    example: 'e.g. they announce a funding round',
  },
  {
    key: 'only_if',
    label: 'Only if',
    help: 'What else has to be true about them before the claim below is honest. Leave empty only if it holds for every account you would ever contact.',
    example: 'e.g. they already have a sales team to grow',
  },
  {
    key: 'so',
    label: 'So',
    help: 'What that event costs them, in their terms. Not what you sell.',
    example: 'e.g. hiring gets ahead of anyone to manage it',
  },
  {
    key: 'ask',
    label: 'Ask',
    help: 'The one thing you want them to do. Small enough that a stranger would say yes.',
    example: 'e.g. try it on ten accounts before they hire',
  },
];

type ArgumentDraft = {
  id: string;
  account: string | null;
  body: string;
  created_at: string;
  state: 'pending' | 'approved' | 'rejected';
};
type ArgumentDrafts = { drafts: ArgumentDraft[]; counted: number; limit: number };

/** Grows with its content, so nothing you are asked to approve is cut off. */
function GrowingTextarea(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      rows={1}
      placeholder={props.placeholder}
      style={{
        width: '100%', fontSize: '.8rem', lineHeight: 1.5, padding: '.4rem .5rem',
        resize: 'none', overflow: 'hidden', minHeight: '2.2rem',
        border: '1px solid var(--border)', borderRadius: 5,
        background: 'var(--bg)', color: 'var(--text)',
      }}
    />
  );
}

/**
 * The four fields read back as the sentence they are, because that is the thing
 * being judged. Each part keeps its own tint so you can see which box a phrase
 * came from without opening the boxes.
 */
function ArgumentSentence({ a }: { a: DrafterArgument }) {
  const part = (text: string, field: string, color: string) => (
    <span title={field} style={{ color, borderBottom: '1px dotted var(--border)' }}>{text}</span>
  );
  const when = (a.when ?? '').trim();
  const onlyIf = (a.only_if ?? '').trim();
  const so = (a.so ?? '').trim();
  const ask = (a.ask ?? '').trim();
  if (!when && !so && !ask) {
    return <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Nothing written yet. Open the wording below and fill it in.</span>;
  }
  return (
    <span>
      {when && <>When {part(when, 'When', 'var(--text)')}</>}
      {onlyIf && <>, and {part(onlyIf, 'Only if', 'var(--text-2)')}</>}
      {so && <>, {part(so, 'So', 'var(--text)')}</>}
      {ask && <>. So we ask them to {part(ask, 'Ask', 'var(--text)')}</>}
      .
    </span>
  );
}

export function ArgumentsEditor({
  values,
  onChange,
  showConfirm = true,
  workspaceId,
}: {
  values: DrafterArgument[];
  onChange: (next: DrafterArgument[]) => void;
  /**
   * Hidden during setup. Confirming means "I read the three messages this wrote
   * and they make sense", and at setup there are none, so offering the decision
   * there would ask someone to vouch for something that does not exist.
   */
  showConfirm?: boolean;
  /** Omitted during setup, where no drafts exist yet to go and fetch. */
  workspaceId?: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, ArgumentDrafts>>({});
  const [accounts, setAccounts] = useState<number | null>(null);
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!workspaceId || !showConfirm) return;
    let live = true;
    fetch(`/api/workspace/argument_drafts?workspace_id=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j) return;
        if (j.arguments) setDrafts(j.arguments);
        if (typeof j.accounts === 'number') setAccounts(j.accounts);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [workspaceId, showConfirm]);

  function patch(i: number, field: 'when' | 'only_if' | 'so' | 'ask', v: string) {
    onChange(values.map((a, j) => {
      if (j !== i) return a;
      const next = { ...a, [field]: v };
      // A confirmation is about the words that were confirmed. Change them and
      // it goes back to three messages and a look.
      delete next.proven_at;
      return next;
    }));
  }

  function setConfirmed(i: number, on: boolean) {
    onChange(values.map((a, j) => {
      if (j !== i) return a;
      const next = { ...a };
      if (on) next.proven_at = new Date().toISOString();
      else delete next.proven_at;
      return next;
    }));
  }

  function acceptProposal(i: number) {
    onChange(values.map((a, j) => {
      if (j !== i || !a.proposal) return a;
      const { proposal, ...rest } = a;
      // Deliberately through the same path as a hand edit: the words changed, so
      // the confirmation goes and the trial starts over. That is the safety net
      // that makes accepting a machine-written argument a small decision.
      const next = { ...rest, when: proposal.when, so: proposal.so, ask: proposal.ask };
      if (proposal.only_if) next.only_if = proposal.only_if; else delete next.only_if;
      delete next.proven_at;
      return next;
    }));
  }

  function dismissProposal(i: number) {
    onChange(values.map((a, j) => {
      if (j !== i) return a;
      const { proposal, ...rest } = a;
      return rest;
    }));
  }

  function add() {
    const id = `argument_${values.length + 1}`;
    onChange([...values, { id, label: '', when: '', so: '', ask: '', enabled: true }]);
    setEditing((e) => ({ ...e, [id]: true }));
  }

  const book = accounts ? accounts.toLocaleString() : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {values.length === 0 && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          No arguments. The drafter falls back to picking one of your pain points and working out the
          connection itself on every message.
        </div>
      )}

      {values.map((a, i) => {
        const d = drafts[a.id];
        const written = d?.drafts.length ?? 0;
        const counted = d?.counted ?? 0;
        const limit = d?.limit ?? 3;
        const stopped = counted >= limit;
        const isEditing = Boolean(editing[a.id]);
        const confirmed = Boolean(a.proven_at);
        return (
          <div key={a.id ?? i} style={{
            border: `1px solid ${!confirmed && stopped ? 'var(--badge-amber-fg)' : 'var(--border)'}`,
            borderRadius: 10, background: 'var(--panel)', overflow: 'hidden',
          }}>
            {/* Header: name and where this argument stands. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.6rem .8rem', borderBottom: '1px solid var(--border)' }}>
              <input
                value={a.label ?? ''}
                onChange={(e) => onChange(values.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                placeholder="Short name for this argument"
                style={{
                  flex: 1, fontSize: '.9rem', fontWeight: 600, padding: '.2rem .3rem',
                  border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: 'var(--text)',
                }}
              />
              <span style={{
                fontSize: '.65rem', padding: '.15rem .5rem', borderRadius: 999, whiteSpace: 'nowrap', fontWeight: 600,
                background: confirmed ? 'var(--accent-green-soft)' : 'var(--accent-amber-soft)',
                color: confirmed ? 'var(--badge-green-fg)' : 'var(--badge-amber-fg)',
              }}>
                {confirmed ? 'in use' : stopped ? 'stopped, waiting on you' : 'on trial'}
              </span>
              <button
                onClick={() => onChange(values.filter((_, j) => j !== i))}
                style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                aria-label="Remove this argument"
              >×</button>
            </div>

            {/* The argument itself, as a sentence rather than four boxes. */}
            <div style={{ padding: '.8rem', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '.88rem', lineHeight: 1.65, color: 'var(--text-2)' }}>
                <ArgumentSentence a={a} />
              </div>
              <button
                onClick={() => setEditing((e) => ({ ...e, [a.id]: !isEditing }))}
                style={{
                  marginTop: '.5rem', fontSize: '.72rem', padding: '.2rem .5rem', cursor: 'pointer',
                  border: '1px solid var(--border)', borderRadius: 5, background: 'transparent', color: 'var(--text-3)',
                }}
              >{isEditing ? 'Done editing' : 'Edit the wording'}</button>

              {isEditing && (
                <div style={{ marginTop: '.6rem', paddingTop: '.6rem', borderTop: '1px dashed var(--border)' }}>
                  {FIELDS.map((f) => (
                    <div key={f.key} style={{ marginBottom: '.6rem' }}>
                      <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text)' }}>{f.label}</div>
                      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', lineHeight: 1.4, margin: '.05rem 0 .2rem' }}>{f.help}</div>
                      <GrowingTextarea
                        value={(a[f.key] ?? '') as string}
                        onChange={(v) => patch(i, f.key, v)}
                        placeholder={f.example}
                      />
                    </div>
                  ))}
                  {confirmed && (
                    <div style={{ fontSize: '.7rem', color: 'var(--badge-amber-fg)' }}>
                      Changing any of these makes it a different argument, so it goes back on trial and writes {limit} more before it runs everywhere again.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* A rewrite the weekly review is suggesting. Sits above the
                evidence because it is the newest thing that happened here. */}
            {a.proposal && (
              <div style={{ padding: '.8rem', borderBottom: '1px solid var(--border)', background: 'var(--accent-amber-soft)' }}>
                <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--badge-amber-fg)', marginBottom: '.3rem' }}>
                  Suggested rewrite
                </div>
                <div style={{ fontSize: '.75rem', color: 'var(--text-2)', lineHeight: 1.5, marginBottom: '.5rem' }}>
                  {a.proposal.why}
                </div>
                <div style={{ fontSize: '.85rem', lineHeight: 1.6, color: 'var(--text)', marginBottom: '.6rem' }}>
                  <ArgumentSentence a={{ ...a, ...a.proposal }} />
                </div>
                <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => acceptProposal(i)}
                    style={{
                      fontSize: '.78rem', fontWeight: 600, padding: '.35rem .7rem', cursor: 'pointer',
                      border: '1px solid var(--badge-green-fg)', borderRadius: 6,
                      background: 'var(--accent-green-soft)', color: 'var(--badge-green-fg)',
                    }}
                  >Use this wording</button>
                  <button
                    onClick={() => dismissProposal(i)}
                    style={{
                      fontSize: '.78rem', padding: '.35rem .7rem', cursor: 'pointer',
                      border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel)', color: 'var(--text-2)',
                    }}
                  >Keep what I have</button>
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: '.4rem' }}>
                  Taking it counts as an edit, so it writes {limit} messages and stops again before it runs on the book.
                </div>
              </div>
            )}

            {/* The evidence, and then the decision. */}
            {showConfirm && (
              <div style={{ padding: '.8rem' }}>
                <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: '.5rem' }}>
                  {confirmed
                    ? <>In use. It writes to any account it fits{book ? <> out of your {book}</> : null}.</>
                    : stopped
                      ? <>It wrote these {written} and stopped{book ? <>, with {book} accounts in your book behind them</> : null}. Read them.</>
                      : written > 0
                        ? <>{counted} of {limit} trial messages written{book ? <>, out of {book} accounts</> : null}. It stops at {limit} until you decide.</>
                        : <>Nothing written yet. It writes {limit}{book ? <> of your {book} accounts</> : null}, then stops until you decide.</>}
                </div>

                {written > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', marginBottom: '.7rem' }}>
                    {d!.drafts.map((dr) => (
                      <div key={dr.id} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
                        <div style={{
                          display: 'flex', gap: '.5rem', alignItems: 'baseline', justifyContent: 'space-between',
                          padding: '.4rem .6rem', borderBottom: '1px solid var(--border)', fontSize: '.7rem', color: 'var(--text-3)',
                        }}>
                          <strong style={{ color: 'var(--text)', fontSize: '.78rem' }}>{dr.account ?? 'unknown account'}</strong>
                          <span>
                            {new Date(dr.created_at).toLocaleDateString()}
                            {' · '}
                            {dr.state === 'pending' ? 'waiting for you to approve or reject'
                              : dr.state === 'approved' ? 'you approved it' : 'you rejected it'}
                          </span>
                        </div>
                        <div style={{ padding: '.5rem .6rem', fontSize: '.78rem', lineHeight: 1.6, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{dr.body}</div>
                      </div>
                    ))}
                  </div>
                )}

                {confirmed ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', fontSize: '.75rem', color: 'var(--text-3)' }}>
                    <span>You said these made sense on {new Date(a.proven_at!).toLocaleDateString()}.</span>
                    <button
                      onClick={() => setConfirmed(i, false)}
                      style={{
                        fontSize: '.72rem', padding: '.25rem .55rem', cursor: 'pointer',
                        border: '1px solid var(--border)', borderRadius: 5, background: 'transparent', color: 'var(--text-2)',
                      }}
                    >Put it back on trial</button>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text)', marginBottom: '.4rem' }}>
                      {written > 0 ? `Do these ${written} make sense?` : 'Nothing to judge yet.'}
                    </div>
                    <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setConfirmed(i, true)}
                        disabled={written === 0}
                        style={{
                          fontSize: '.78rem', fontWeight: 600, padding: '.4rem .8rem',
                          cursor: written === 0 ? 'not-allowed' : 'pointer', opacity: written === 0 ? .5 : 1,
                          border: '1px solid var(--badge-green-fg)', borderRadius: 6,
                          background: 'var(--accent-green-soft)', color: 'var(--badge-green-fg)',
                        }}
                      >Yes{book ? ` — use it on all ${book}` : ' — use it everywhere'}</button>
                      <button
                        onClick={() => setEditing((e) => ({ ...e, [a.id]: true }))}
                        style={{
                          fontSize: '.78rem', padding: '.4rem .8rem', cursor: 'pointer',
                          border: '1px solid var(--border)', borderRadius: 6,
                          background: 'var(--panel-2)', color: 'var(--text-2)',
                        }}
                      >No — I&apos;ll rewrite it</button>
                    </div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: '.4rem' }}>
                      Saving is what applies this. Nothing changes until you hit save at the bottom of the page.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div>
        <button
          onClick={add}
          style={{
            fontSize: '.75rem', padding: '.35rem .7rem', cursor: 'pointer',
            border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel-2)', color: 'var(--text-2)',
          }}
        >+ Add an argument</button>
      </div>
    </div>
  );
}
