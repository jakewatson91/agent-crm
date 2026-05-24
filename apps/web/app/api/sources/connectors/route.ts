import { NextResponse } from 'next/server';
import { listConnectors } from '@agent-crm/inngest/functions/sources/registry_meta';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ connectors: listConnectors() });
}
