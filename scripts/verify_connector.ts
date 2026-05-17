/**
 * End-to-end test of the custom_http connector path.
 *
 *   pnpm tsx scripts/verify_connector.ts
 *
 * Walks the full wizard flow against the public HN Algolia API (no auth):
 *   1. fetch raw response (Step 2 of wizard)
 *   2. call the spec-generator LLM with a real description (Step 3)
 *   3. run the custom_http connector with the generated spec
 *   4. print what was extracted — entities + facts + signals
 *
 * Read-only at the wizard layers (no source row created). The connector run
 * DOES write to the demo workspace if it extracts anything; the script
 * prints what would be written first and aborts before persistence unless
 * --apply is passed.
 *
 *   pnpm tsx scripts/verify_connector.ts          # dry run, prints spec + LLM extraction
 *   pnpm tsx scripts/verify_connector.ts --apply  # actually runs the connector against prod
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
// Direct connector import to avoid invoking the Inngest layer.
import customHttp from '../inngest/functions/sources/connectors/custom_http.js';

const HN_URL = 'https://hn.algolia.com/api/v1/search?query=AI%20CRM&tags=story&hitsPerPage=10';
const DESCRIPTION = 'I want to track Hacker News stories about AI-native CRMs and agent-driven sales tools. Extract any company name mentioned in the title or url, plus facts about what they do (product type, target market) and what makes them notable (raised, launched, hiring, controversy).';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE (will write to demo workspace) ===' : '=== DRY RUN (no writes) ===');

  // 1. Fetch sample
  console.log('\n[1] fetching HN Algolia sample...');
  const sampleRes = await fetch(HN_URL);
  const sample = await sampleRes.json();
  console.log(`   hits: ${sample.hits?.length ?? 0}`);
  if (!sample.hits?.length) { console.log('no hits, abort'); return; }
  console.log(`   first hit title: ${sample.hits[0].title}`);

  // 2. Generate spec via LLM (same prompt as the API route)
  console.log('\n[2] generating spec via LLM...');
  const sys = `You generate a connector specification for an agent-native CRM. The CRM fetches a URL on a schedule, walks the response to a list of items, and uses an LLM to extract entities and facts from each batch.

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
  "signal_type": "<short lowercase identifier, snake_case>",
  "rationale": "<2-3 sentences explaining your choices>"
}

EXTRACTION_PROMPT RULES — the prompt you write MUST instruct the runtime LLM to:
1. Receive batched items as JSON.
2. Output strictly valid JSON in this shape:
   {
     "entities": [
       {
         "name": "<canonical entity name>",
         "domain": "<optional>",
         "facts": [
           { "predicate": "<snake_case>", "object_text": "<concise value>", "confidence": 0.0-1.0 }
         ],
         "signal_body": "<one short sentence summarizing the observation>"
       }
     ],
     "rejected": [
       { "item_index": <int>, "reason": "<short reason code>" }
     ]
   }
3. ATOMIC facts: one predicate, one value. Verbatim grounded — only what's in the item.
4. Skip items where no entity can be identified; put them in "rejected".
5. Don't invent — if a fact isn't supported, don't emit it.

Predicates you write into the extraction prompt examples MUST be specific to the customer's use case.

Return ONLY the JSON object.`;

  const userPrompt = `URL: ${HN_URL}
METHOD: GET
SAMPLE RESPONSE:
${JSON.stringify(sample, null, 2).slice(0, 6000)}

CUSTOMER DESCRIPTION:
${DESCRIPTION}

Generate the connector spec.`;

  const llm = await chatComplete({
    model: 'gpt-4o-mini',
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userPrompt },
    ],
  });
  const derived = JSON.parse(llm.text);
  console.log(`   response_path: "${derived.response_path}"`);
  console.log(`   item_id_path:  "${derived.item_id_path}"`);
  console.log(`   signal_type:   "${derived.signal_type}"`);
  console.log(`   batch_size:    ${derived.batch_size}`);
  console.log(`   rationale:     ${derived.rationale}`);
  console.log(`   extraction_prompt (first 240 chars):`);
  console.log(`   "${(derived.extraction_prompt as string).slice(0, 240)}..."`);

  if (!apply) {
    console.log('\n[3] DRY RUN — skipping connector run. Pass --apply to actually run.');
    return;
  }

  // 3. Run the connector with the generated spec
  console.log('\n[3] running custom_http connector...');
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name').like('name', 'demo · agent-crm%').limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;
  console.log(`   workspace: ${ws.data.name} (${WS.slice(0, 8)})`);

  const spec = {
    fetch: { url: HN_URL, method: 'GET', response_path: derived.response_path ?? '' },
    extract: { system_prompt: derived.extraction_prompt, batch_size: derived.batch_size ?? 5, model: 'gpt-4o-mini' },
    signal: { type: derived.signal_type ?? 'hn_ai_crm', magnitude: 0.55 },
    dedup: { since_hours: 168, item_id_path: derived.item_id_path ?? 'objectID' },
  };

  const result = await customHttp({
    supabase: sb,
    workspace_id: WS,
    source_id: 'verify-script-test',
    config: spec,
    last_run_at: null,
  });

  console.log(`\n[4] connector result:`);
  console.log(`   signals_created:  ${result.signals_created}`);
  console.log(`   entities_created: ${result.entities_created}`);
  console.log(`   skipped:          ${result.skipped}`);
  console.log(`   errors:           ${result.errors.length}`);
  for (const e of result.errors.slice(0, 5)) console.log(`     - ${e.slice(0, 200)}`);

  console.log('\n[5] acceptance:');
  console.log(`   [${result.signals_created + result.entities_created > 0 ? 'OK' : 'FAIL'}] connector emitted at least one signal or entity`);
  console.log(`   [${result.errors.length === 0 ? 'OK' : 'WARN'}] no errors during run`);
}

main().catch((e) => { console.error(e); process.exit(1); });
