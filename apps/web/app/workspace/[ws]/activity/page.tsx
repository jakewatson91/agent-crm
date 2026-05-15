import { redirect } from 'next/navigation';

// Activity is folded into Feed. Anything that linked here forwards on.
export default async function ActivityRedirect({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/workspace/${ws}/channels`);
}
