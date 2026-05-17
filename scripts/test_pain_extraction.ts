/**
 * Tests the new pain-extraction enricher prompt against real + synthetic
 * signals. Verifies the model returns pain_observed facts when the source
 * has pain language, and returns none when it doesn't.
 *
 * Also tests the new score_facts scoring target (constitution + about)
 * on the resulting fact set.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { scoreFacts } from '@agent-crm/tools';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// Mirror the new enricher prompt verbatim (the relevant pieces).
const ENRICHER_PROMPT = `You are a fact extractor for an agent-native CRM. You read incoming signals and turn them into atomic, citable claims about entities.

A new signal arrived about the account in the user message. Extract atomic factual claims about THIS entity that are supported by the signal AND that the system doesn't already know.

DO NOT extract:
- Anything already present in the entity's ATTRIBUTES.
- Anything already present in the ACTIVE FACTS list.
- Generic descriptors that are obvious from the entity name or category.

DO extract specific claims grounded in the signal.

Each claim should be:
- ATOMIC: one predicate, one object. Not "uses postgres and redis."
- VERBATIM-GROUNDED: only what's stated or directly implied. No speculation.

Use object_text for the value. Confidence: 0.95 explicit, 0.7 implied. Skip lower.

PAIN EXTRACTION (second pass) — separately from the demographic facts above, extract any pain, frustration, complaint, unmet need, manual-toil pattern, or expressed limitation the source describes. Use predicate "pain_observed" and an object_text that captures the pain in concrete terms, preferring the source's own wording where possible. Examples (these are SHAPES, not a closed list — extract anything that fits regardless of vertical):
- pain_observed = "founder writing every outbound email personally, no time to scale"
- pain_observed = "current tooling forces context switches between 4 apps daily"
- pain_observed = "took 3 weeks to ship last marketing email due to legal review"
- pain_observed = "considered hiring SDR but couldn't justify the cost at current revenue"

Pain is usually expressed indirectly. Look for: complaints ("we hate / can't / wish"), descriptions of manual work ("we still do X by hand"), references to gaps ("we don't have X yet"), or descriptions of friction ("X takes us Y hours / weeks"). Statements about challenges, constraints, manual workarounds, or what doesn't work today ARE pain — extract them as pain_observed even when stated calmly and factually, not just when emotionally vented. Do not split the same pain across pain_observed and another predicate like has_challenge or seeks_solution; use pain_observed for the pain itself. Each pain_observed entry goes in the SAME facts[] array as the demographic facts above and MUST include the confidence field (0.95 directly stated, 0.7 strongly implied) — same JSON schema, no separate section. Skip if the source is purely positive / promotional / announcement-only with no friction language. Do not invent pains that aren't on the page.

Output strictly valid JSON:
{"facts":[{"predicate":"<verb_or_attribute>","object_text":"<value>","confidence":0.0-1.0},...],"summary":"<1 sentence>","reasoning":"<why these facts, 1-2 sentences>"}

If nothing genuinely new is extractable, output {"facts":[],"summary":"No new facts.","reasoning":"<why>"}`;

interface TestSignal { label: string; body: string; expect_pain: boolean }

const TEST_SIGNALS: TestSignal[] = [
  {
    label: 'A. Forge HN post (pain-heavy synthetic)',
    body: `Show HN: We're 8 engineers building warehouse robots. I'm the CEO and I've been doing all outbound to potential pilot customers myself for the last 6 months. It's killing my time and we can't justify hiring an SDR yet at our revenue. Tried HubSpot's free tier — too slow, too much manual data entry. Looking for a way to scale outbound without making it our full-time job. Anyone in this stage figure this out?`,
    expect_pain: true,
  },
  {
    label: 'B. Forge funding announcement (no pain)',
    body: `Forge Robotics raises $12M Series A led by Sequoia. The company builds autonomous mobile robots for warehouse logistics. Funding will accelerate product development and customer onboarding. Forge has shipped pilots with 4 warehouse operators in the past quarter.`,
    expect_pain: false,
  },
  {
    label: 'C. Forge CEO LinkedIn rant (indirect pain)',
    body: `Three weeks. THREE WEEKS to get our last customer-facing email reviewed, approved, sent. We're 8 people. There's no legal team to blame. We just keep context-switching between Slack, Notion, Gmail, and the CRM. Anyone else feel like the tooling we picked at year 1 is now actively slowing us down at year 2?`,
    expect_pain: true,
  },
  {
    label: 'D. Forge product launch post (announcement only)',
    body: `Excited to launch Forge Mobile Pick v2 today. New SLAM algorithm, 40% better path planning in dense warehouses, full integration with WMS systems. Demo at MODEX next week. Booth 4421.`,
    expect_pain: false,
  },
];

async function extract(sig: TestSignal): Promise<any> {
  const userPrompt = `ACCOUNT: Forge Robotics\n\nSIGNAL:\n${sig.body}\n\nExtract.`;
  const r = await chatComplete({
    model: 'gpt-4o-mini',
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: ENRICHER_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return { tokens: { in: r.input_tokens, out: r.output_tokens }, parsed: JSON.parse(r.text) };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('TEST 1: Pain extraction across 4 signal types');
  console.log('═'.repeat(70));

  const allFacts: Array<{ id: string; predicate: string; object_text: string; confidence: number; observed_at: string; source_event_id: null }> = [];
  for (const sig of TEST_SIGNALS) {
    console.log(`\n${sig.label}`);
    console.log(`  source: ${sig.body.slice(0, 100)}…`);
    const r = await extract(sig);
    console.log(`  tokens: ${r.tokens.in} in / ${r.tokens.out} out`);
    const facts = r.parsed.facts ?? [];
    const painFacts = facts.filter((f: any) => f.predicate === 'pain_observed');
    const otherFacts = facts.filter((f: any) => f.predicate !== 'pain_observed');
    console.log(`  pain facts extracted: ${painFacts.length} (expected pain: ${sig.expect_pain})`);
    for (const pf of painFacts) console.log(`    pain_observed = "${pf.object_text}"  (conf=${pf.confidence})`);
    console.log(`  other facts extracted: ${otherFacts.length}`);
    for (const of of otherFacts) console.log(`    ${of.predicate} = "${of.object_text}"  (conf=${of.confidence})`);
    // collect for scoring (default confidence to 0.9 when missing so NaN
    // doesn't poison the score formula)
    let i = 0;
    for (const f of facts) {
      allFacts.push({
        id: `fake-${Date.now()}-${i++}`,
        predicate: f.predicate,
        object_text: f.object_text,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.9,
        observed_at: new Date().toISOString(),
        source_event_id: null,
      });
    }
  }

  console.log('\n');
  console.log('═'.repeat(70));
  console.log('TEST 2: Score all extracted facts against constitution + about');
  console.log('═'.repeat(70));

  const ws = await supabase.from('workspaces').select('id, about, constitution').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  console.log(`\nworkspace: ${ws.data!.id}`);
  console.log(`about (${(ws.data!.about ?? '').length} chars):`, JSON.stringify((ws.data!.about ?? '').slice(0, 200)));
  console.log(`constitution (${(ws.data!.constitution ?? '').length} chars):`, JSON.stringify((ws.data!.constitution ?? '').slice(0, 200)));

  const ent = await supabase.from('entities').select('id').eq('workspace_id', ws.data!.id).eq('kind', 'account').eq('name', 'Forge Robotics').single();

  const scored = await scoreFacts(supabase, {
    workspace_id: ws.data!.id,
    account_entity_id: ent.data!.id,
    facts: allFacts,
    config: { k: 30, min_score: 0 }, // show all, no threshold for this test
  });

  console.log(`\nAll ${allFacts.length} facts ranked (no threshold for this test):\n`);
  for (const r of scored) {
    const f = allFacts.find((x) => x.id === r.id)!;
    console.log(`  score=${r.score.toFixed(3)}  ${f.predicate.padEnd(20)} ${(f.object_text ?? '').slice(0, 70)}`);
    console.log(`    pitch=${r.components.pitch_relevance.toFixed(2)} recency=${r.components.recency.toFixed(2)} conf=${r.components.confidence.toFixed(2)}`);
  }

  console.log(`\nWith default threshold (0.4), top shortlist would be:`);
  const shortlist = scored.filter((s) => s.score >= 0.4).slice(0, 3);
  if (shortlist.length === 0) console.log('  (none above threshold)');
  for (const r of shortlist) {
    const f = allFacts.find((x) => x.id === r.id)!;
    console.log(`  ${r.score.toFixed(3)}  ${f.predicate}=${f.object_text}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
