import { redirect } from 'next/navigation';

export default async function WorkspaceHome({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  redirect(`/workspace/${ws}/gates`);
}
