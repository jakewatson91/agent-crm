import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: '2rem', maxWidth: 720 }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>agent-crm</h1>
      <p style={{ color: '#999', marginBottom: '2rem' }}>
        Agent-first CRM. The agent is the primary user. Humans only intervene at gates.
      </p>
      <p style={{ color: '#666' }}>
        Sign in to access your workspace.{' '}
        <Link href="/login" style={{ color: '#7aa2f7' }}>Login</Link>
      </p>
    </main>
  );
}
