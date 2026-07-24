import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'agent-crm',
  description: 'Agent-first CRM',
};

// Set the saved theme before first paint so there's no flash of the wrong
// theme. No stored value = follow the OS (the CSS media query governs). The
// StatusBar toggle writes localStorage.theme.
const NO_FLASH = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
