import { redirect } from 'next/navigation';

// Integrations folded into the unified Connectors hub. Keep the route as a
// redirect so old links (and the OAuth callback's return path) still land.
export default async function IntegrationsRedirect({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/workspace/${ws}/settings/connectors`);
}
