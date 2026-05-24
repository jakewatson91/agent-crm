'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getBrowserClient } from '../_lib/supabase-browser';

function LoginInner() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
              padding: '.6rem 1rem', background: '#9ece6a', color: '#000', border: 'none',
              borderRadius: 6, cursor: 'pointer', fontWeight: 500, opacity: busy || !email ? 0.4 : 1,
            }}
          >
            {busy ? 'sending…' : 'send magic link'}
          </button>
          {err && <div style={{ color: '#f7768e', fontSize: '.85rem' }}>{err}</div>}
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
