/**
 * Render the drafter "decision" prompt block from a set of policy values.
 * Stateless — takes proposed values in the body, returns the rendered prompt.
 * Lets the Settings UI show exactly what the LLM will be told before save.
 */
import { NextResponse } from 'next/server';
import { buildDrafterDecision, type DrafterDecisionOpts } from '@agent-crm/tools';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as DrafterDecisionOpts | null;
  if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 });
  const prompt = buildDrafterDecision(body);
  return NextResponse.json({ ok: true, prompt });
}
