'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getBrowserClient } from '../_lib/supabase-browser';

function LoginInner() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(params.get('error_description') || params.get('error'));
  const [busy, setBusy] = useState(false);

  // Some auth failures come back in the URL hash (#error=...) instead of the query.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash) return;
    const h = new URLSearchParams(window.location.hash.slice(1));
    const hashErr = h.get('error_description') || h.get('error');
    if (hashErr) {
      setErr(hashErr);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const sb = getBrowserClient();
      const origin = typeof window === 'undefined' ? '' : window.location.origin;
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) { setErr(error.message); return; }
      setSent(true);
    } finally { setBusy(false); }
  }

  return (
    <main style={{ padding: '4rem 2rem', maxWidth: 420, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '.25rem' }}>
        <span style={{ color: 'var(--accent)', marginRight: '.4rem' }}>✦</span>agent-crm
      </h1>
      <p style={{ color: 'var(--text-3)', fontSize: '.9rem', marginBottom: '2rem' }}>
        Sign in with a magic link.
      </p>

      {sent ? (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 8, fontSize: '.9rem' }}>
          Check <strong>{email}</strong> for a sign-in link. You can close this tab.
        </div>
      ) : (
        <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={{
              padding: '.6rem .8rem', background: 'var(--bg)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.95rem',
            }}
          />
          <button
            type="submit"
            disabled={busy || !email}
            style={{
              padding: '.6rem 1rem', background: 'var(--accent-green)', color: '#fff', border: 'none',
              borderRadius: 6, cursor: 'pointer', fontWeight: 500, opacity: busy || !email ? 0.4 : 1,
            }}
          >
            {busy ? 'sending…' : 'send magic link'}
          </button>
          {err && <div style={{ color: 'var(--accent-coral)', fontSize: '.85rem' }}>{err}</div>}
        </form>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main style={{ padding: '4rem 2rem' }}>loading…</main>}>
      <LoginInner />
    </Suspense>
  );
}
