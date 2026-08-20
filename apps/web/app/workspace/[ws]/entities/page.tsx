/**
 * Entities index — server component that inlines the first payload as SWR
 * fallbackData, same pattern as Today (page.tsx) and Feed (feed/page.tsx).
 * Only the data crosses the server/client boundary here; all rendering still
 * happens in EntitiesClient.tsx, so this doesn't reintroduce the RSC
 * serialization cost the pipeline was moved off of previously (see the doc
 * comment in EntitiesClient.tsx). Auth is enforced by the workspace layout
 * (requireRole).
 */
import { getEntitiesPageData } from '../../../_lib/entities_index';
import { EntitiesClient } from './EntitiesClient';

export default async function EntitiesIndexPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const data = await getEntitiesPageData(ws);
  return <EntitiesClient ws={ws} initialData={data} />;
}
