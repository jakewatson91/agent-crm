'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getBrowserClient } from '../../_lib/supabase-browser';

type State =
  | { kind: 'loading' }
  | { kind: 'need_login'; }
  | { kind: 'accepting' }
  | { kind: 'ok'; workspace_id: string; email_mismatch: boolean; already: boolean }
  | { kind: 'err'; msg: string };

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function go() {
      const sb = getBrowserClient();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) {
        if (!cancelled) setState({ kind: 'need_login' });
        return;
      }
      if (!cancelled) setState({ kind: 'accepting' });
      const r = await fetch('/api/workspace/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const j = await r.json();
      if (!r.ok) {
        if (!cancelled) setState({ kind: 'err', msg: j.error ?? 'accept failed' });
        return;
      }
      if (!cancelled) setState({
        kind: 'ok',
        workspace_id: j.workspace_id,
        email_mismatch: !!j.email_mismatch,
        already: !!j.already_accepted,
      });
    }
    go();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (state.kind === 'ok' && !state.email_mismatch) {
      const t = setTimeout(() => router.push(`/workspace/${state.workspace_id}`), 1500);
      return () => clearTimeout(t);
    }
  }, [state, router]);

  return (
    <main style={{ padding: '4rem 2rem', maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '1.5rem' }}>
        <span style={{ color: 'var(--accent)', marginRight: '.4rem' }}>✦</span>agent-crm invitation
      </h1>

      {state.kind === 'loading' && <p style={{ color: 'var(--text-3)' }}>loading…</p>}

      {state.kind === 'need_login' && (
        <div>
          <p style={{ color: 'var(--text-2)', marginBottom: '1rem' }}>
            Sign in to accept this invitation.
          </p>
          <a
            href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            style={{ display: 'inline-block', padding: '.55rem 1rem', background: 'var(--accent-green)', color: '#fff', borderRadius: 6, textDecoration: 'none', fontWeight: 500 }}
          >
            sign in
          </a>
        </div>
      )}

      {state.kind === 'accepting' && <p style={{ color: 'var(--text-3)' }}>accepting…</p>}

      {state.kind === 'ok' && (
        <div>
          <p style={{ color: 'var(--accent-green)', marginBottom: '.5rem' }}>
            ✓ {state.already ? 'already a member' : 'joined the workspace'}
          </p>
          {state.email_mismatch && (
            <p style={{ color: 'var(--accent-amber)', fontSize: '.85rem', marginBottom: '1rem' }}>
              Note: this invitation was for a different email than the one you signed in with. You've been added anyway.
            </p>
          )}
          <a href={`/workspace/${state.workspace_id}`} style={{ color: 'var(--text)', textDecoration: 'underline' }}>
            Go to workspace →
          </a>
        </div>
      )}

      {state.kind === 'err' && (
        <p style={{ color: 'var(--accent-coral)' }}>{state.msg}</p>
      )}
    </main>
  );
}
