import type { ReactNode } from 'react';

export const metadata = {
  title: 'agent-crm',
  description: 'Agent-first CRM',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0, background: '#0a0a0a', color: '#e5e5e5' }}>
        {children}
      </body>
    </html>
  );
}
