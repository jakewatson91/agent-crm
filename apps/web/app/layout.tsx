import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'agent-crm',
  description: 'Agent-first CRM',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
