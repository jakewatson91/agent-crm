import { redirect } from 'next/navigation';

export default async function SettingsRedirect({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/workspace/${ws}/settings/connectors`);
}
