import type { ReactNode } from 'react';
import { SettingsSubnav } from './_components/SettingsSubnav';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  return (
    <section style={{ display: 'flex', gap: '2rem', maxWidth: 1100 }}>
      <SettingsSubnav ws={ws} />
      <div style={{ flex: 1, minWidth: 0, maxWidth: 820 }}>{children}</div>
    </section>
  );
}
