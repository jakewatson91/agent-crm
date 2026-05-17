/**
 * One-shot backfill: move dog-food values that used to live in env vars / code
 * constants onto workspaces.policy. Idempotent — safe to re-run; merges with
 * whatever's already there. Run once after the policy.ts refactor lands so the
 * existing workspace keeps its behavior.
 *
 *   pnpm tsx scripts/backfill_policy.ts
 *
 * Optional flag: --workspace=<uuid> to target a specific workspace; otherwise
 * backfills every workspace whose policy is missing the new fields.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

// Phrases we wanted scrubbed from drafts before this file existed — moved here
// so a new workspace doesn't inherit them by default.
const DOGFOOD_BANNED_PHRASES = [
  'best in class',
  'world class',
  'next gen',
  'next-gen',
];

// Enricher examples for the dog-food workspace (selling agent-crm to founders
// running sales with ≤1 person). These shape what the LLM looks for when
// reading incoming signals. Editable per-workspace.
const DOGFOOD_ENRICHER_EXAMPLES: Array<{ predicate: string; object_text: string }> = [
  { predicate: 'hiring_for',           object_text: 'SDR / AE / RevOps role being filled' },
  { predicate: 'headcount',            object_text: 'team size — e.g. "3 people"' },
  { predicate: 'sales_motion',         object_text: 'founder-led / inbound / outbound / partner-led' },
  { predicate: 'raised_round',         object_text: 'Series A $12M led by Sequoia' },
  { predicate: 'launched_product',     object_text: 'specific product or feature' },
  { predicate: 'target_market',        object_text: 'who they sell to' },
  { predicate: 'using_ai',             object_text: 'how AI is integrated into their workflow' },
  { predicate: 'token_burn',           object_text: 'mention of inference / LLM costs being a pain' },
];

// Value-prop themes for the dog-food workspace. action_selector only lets a
// draft through when at least one substantive fact matches one of these.
// Patterns are JS regex sources, matched case-insensitive against
// `predicate object_text`. Editable per-workspace via Advanced settings.
const DOGFOOD_VALUE_THEMES = [
  { name: 'hiring',         pattern: '(hiring|backfill|head_of|first.{0,8}hire|sales_hire|talent_gap|open_role|hiring_for|hiring_intent|scaling_outbound_team)' },
  { name: 'headcount',      pattern: '(headcount|layoff|reduce.{0,5}team|team_size|leaner|do.{0,5}more.{0,5}with.{0,5}less)' },
  { name: 'token_cost',     pattern: '(token|llm.{0,5}cost|inference.{0,5}cost|openai.{0,5}bill|anthropic.{0,5}bill|gpu.{0,5}cost|burning.{0,5}credits)' },
  { name: 'ai_integration', pattern: '(integrating.{0,5}ai|adding.{0,5}ai|ai.{0,5}workflow|copilot|llm.{0,5}in.{0,5}production|building.{0,5}with.{0,5}ai|outbound.{0,5}automation|ai.{0,5}agents)' },
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const wsFilter = process.argv.find((a) => a.startsWith('--workspace='))?.split('=')[1];

  const q = sb.from('workspaces').select('id, name, policy');
  if (wsFilter) q.eq('id', wsFilter);
  const { data, error } = await q;
  if (error) throw error;
  if (!data?.length) {
    console.log('no workspaces to backfill');
    return;
  }

  for (const w of data as Array<{ id: string; name: string; policy: Record<string, unknown> | null }>) {
    const existing = (w.policy ?? {}) as Record<string, any>;
    const merged = {
      ...existing,
      outreach: {
        override_to: 'jaws.watson@gmail.com',
        from_email: process.env.RESEND_FROM ?? 'onboarding@resend.dev',
        banned_phrases: DOGFOOD_BANNED_PHRASES,
        ...(existing.outreach ?? {}),
      },
      enrichment: {
        contact_provider: 'hunter',
        example_facts: DOGFOOD_ENRICHER_EXAMPLES,
        ...(existing.enrichment ?? {}),
      },
      drafter: {
        value_themes: DOGFOOD_VALUE_THEMES,
        cooldown_days: 14,
        ...(existing.drafter ?? {}),
      },
    };
    const { error: upErr } = await sb.from('workspaces').update({ policy: merged }).eq('id', w.id);
    if (upErr) {
      console.error(`✗ ${w.name} (${w.id}): ${upErr.message}`);
      continue;
    }
    console.log(`✓ ${w.name} (${w.id})`);
  }
  console.log('done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
