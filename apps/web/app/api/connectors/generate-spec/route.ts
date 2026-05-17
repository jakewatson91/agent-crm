/**
 * Spec generator for custom_http connectors.
 *
 * Input:
 *   - url: where the connector should fetch
 *   - method/headers/body (optional)
 *   - sample_response: a real sample JSON the URL would return (paste-in)
 *   - description: free text "what are you trying to find? what facts matter?"
 *
 * Output: a complete spec the wizard previews + the user edits + saves to
 * sources.config. No DB writes here — this is pure LLM-spec-derivation.
 */
import { NextResponse } from 'next/server';
import { chatComplete } from '@agent-crm/primitives';

export const runtime = 'nodejs';

interface GenSpecReq {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  sample_response: unknown;   // the actual JSON the URL returns (or a representative slice)
  description: string;        // free text from the wizard's "what are you trying to find?"
}

const SYSTEM = `You generate a connector specification for an agent-native CRM. The CRM fetches a URL on a schedule, walks the response to a list of items, and uses an LLM to extract entities and facts from each batch.

You are given:
- A URL the customer wants to monitor.
- A sample JSON response from that URL.
- A free-text description from the customer of what entities + facts matter.

You output strictly valid JSON with this exact shape:
{
  "response_path": "<dot-path into the sample response to the array of items, or empty string if the response IS the array>",
  "item_id_path": "<dot-path on each item to a stable id, or empty string if items have no obvious id>",
  "extraction_prompt": "<the system prompt the runtime LLM will use to extract entities from a batch of items — see rules below>",
  "batch_size": 10,
  "signal_type": "<short lowercase identifier, snake_case, derived from the source (e.g. 'job_listing', 'tweet', 'github_release')>",
  "rationale": "<2-3 sentences explaining your choices to the user>"
}

EXTRACTION_PROMPT RULES — the prompt you write MUST instruct the runtime LLM to:
1. Receive batched items as JSON.
2. Output strictly valid JSON in this shape:
   {
     "entities": [
       {
         "name": "<canonical entity name — usually a company or person>",
         "domain": "<optional, normalized hostname like 'apollo.io'>",
         "facts": [
           { "predicate": "<snake_case verb_or_attribute>", "object_text": "<concise value>", "confidence": 0.0-1.0 }
         ],
         "signal_body": "<one short sentence summarizing the observation, for embedding>"
       }
     ],
     "rejected": [
       { "item_index": <int>, "reason": "<short reason code>" }
     ]
   }
3. ATOMIC facts: one predicate, one value. Verbatim grounded — only what's in the item.
4. Skip items where no entity can be identified; put them in "rejected" with a reason.
5. Don't invent — if a fact isn't supported, don't emit it.

Predicates you write into the extraction prompt examples MUST be specific to the customer's use case (read their description). Don't fall back to B2B SaaS predicates if they're describing real estate, recruiting, partnerships, etc.

Return ONLY the JSON object, no preamble.`;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as GenSpecReq | null;
  if (!body?.url || !body?.sample_response || !body?.description) {
    return NextResponse.json({ error: 'url, sample_response, description required' }, { status: 400 });
  }

  const userPrompt = `URL: ${body.url}
METHOD: ${body.method ?? 'GET'}
${body.headers ? `HEADERS: ${JSON.stringify(body.headers)}\n` : ''}${body.body ? `BODY: ${body.body}\n` : ''}
SAMPLE RESPONSE (truncated to keep prompt small):
${JSON.stringify(body.sample_response, null, 2).slice(0, 6000)}

CUSTOMER DESCRIPTION:
${body.description}

Generate the connector spec.`;

  let derived: {
    response_path: string;
    item_id_path: string;
    extraction_prompt: string;
    batch_size: number;
    signal_type: string;
    rationale: string;
  };
  try {
    const r = await chatComplete({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    });
    derived = JSON.parse(r.text);
  } catch (e) {
    return NextResponse.json({ error: `LLM derive failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  // Compose the full spec the wizard will save into sources.config.
  const spec = {
    fetch: {
      url: body.url,
      method: body.method ?? 'GET',
      headers: body.headers ?? {},
      body: body.body ?? undefined,
      response_path: derived.response_path ?? '',
    },
    extract: {
      system_prompt: derived.extraction_prompt,
      batch_size: derived.batch_size ?? 10,
      model: 'gpt-4o-mini',
    },
    signal: {
      type: derived.signal_type ?? 'custom_http',
      magnitude: 0.55,
    },
    dedup: {
      since_hours: 168,
      item_id_path: derived.item_id_path ?? '',
    },
  };

  return NextResponse.json({ ok: true, spec, rationale: derived.rationale });
}
