/**
 * Test-fetch endpoint for the connector wizard. Runs the user's URL +
 * headers + body and returns the raw response so they can preview before
 * asking the LLM to generate an extraction spec.
 *
 * Truncates to keep payload sane; the wizard shows a "sample" the user can
 * trim further before sending to /generate-spec.
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_BYTES = 200_000;

interface TestReq {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

function interpolate(s: string): string {
  return s.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? '');
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as TestReq | null;
  if (!body?.url) return NextResponse.json({ error: 'url required' }, { status: 400 });

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.headers ?? {})) headers[k] = interpolate(v);

  try {
    const res = await fetch(body.url, {
      method: (body.method ?? 'GET').toUpperCase(),
      headers,
      body: body.body && body.body.trim().length ? body.body : undefined,
    });
    const text = await res.text();
    const truncated = text.length > MAX_BYTES;
    const payload = truncated ? text.slice(0, MAX_BYTES) : text;
    let parsed: unknown = null;
    let parseError: string | null = null;
    try { parsed = JSON.parse(payload); } catch (e) { parseError = e instanceof Error ? e.message : String(e); }
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      truncated,
      raw_size: text.length,
      json: parsed,
      parse_error: parseError,
      // include raw only when parsing fails so the user can debug; otherwise omit to keep response small
      raw_text: parsed == null ? payload.slice(0, 4000) : null,
    });
  } catch (e) {
    return NextResponse.json({ error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
