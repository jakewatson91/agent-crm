'use client';

import { useRouter } from 'next/navigation';
import { getBrowserClient } from '../_lib/supabase-browser';

export function SignOutButton({ email }: { email: string }) {
  const router = useRouter();

  async function signOut() {
    await getBrowserClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div style={{ padding: '0 .65rem' }}>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: '.35rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={email}>
        {email}
      </div>
      <button
        onClick={signOut}
        style={{
          background: 'none', border: '1px solid var(--border)', color: 'var(--text-2)',
          borderRadius: 6, padding: '.35rem .6rem', fontSize: '.75rem', cursor: 'pointer',
          width: '100%', textAlign: 'left', fontFamily: 'inherit',
        }}
      >
        Sign out
      </button>
    </div>
  );
}
