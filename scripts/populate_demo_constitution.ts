/**
 * One-shot: populate the demo workspace's About + Constitution with the real content.
 * Idempotent — safe to re-run.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const ABOUT = `What we are: an AI-native CRM optimized for AI workflows.

Who we replace: legacy row-based CRMs (HubSpot, Salesforce). Truly different from "AI on top of legacy" players (Rox, Day) that still center tables and cards as the primary surface.

How we're different: built for the agent as primary user. Every read carries provenance, every write is an event, every action replays. Information surfaces to humans only when needed, via chat or notification on a messaging app. No tabs to click through, no dashboards to monitor.

Who we sell to: early-stage operators who don't want to inherit legacy patterns. YC-stage founders, solo GTM hires, AI-forward sales teams. People building outbound automation who hit the ceiling of "AI bolted on top of HubSpot."`;

const CONSTITUTION = `Voice: smart friend who actually knows what they're talking about, not a consultant on a slide deck. Casual and confident, not sloppy. Specific and direct, not blunt to the point of being cold.

Writing rules:
- No em dashes. EVER.
- No jargon. If a normal person wouldn't say it out loud, cut it.
- No technical-feeling jargon either. Words like "substrate," "predicate," "abstraction layer," "primitive," "wedge" mean something to programmers but a normal reader won't decode them. Use plain alternatives.
- No preamble unless it earns its place.
- No broad sweeping claims without specific evidence.
- No vague high-level takes. Always specific.
- Fewer words when fewer will do. Always.
- Short sentences.
- If it reads like a template, rewrite it.

Substance:
- Take a stand on things you believe in.
- Open with the actual signal that prompted reaching out, not a generic intro.
- Reference one concrete fact about the account that justifies the fit.
- Close with a one-line ask.

Don't:
- Pitch features. Describe the problem we solve.
- Send to anyone matching the suppression list.
- Use sweeping claims like "the future of sales" or "transforming how teams work."

Hard rules:
- Daily send cap: 50.
- Every claim must cite a fact_id from the active facts list.`;

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb
    .from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('No demo workspace; run pnpm seed first.');

  const upd = await sb.from('workspaces').update({ about: ABOUT, constitution: CONSTITUTION }).eq('id', ws.data.id);
  if (upd.error) throw upd.error;

  console.log(`✓ populated workspace ${ws.data.name} (${ws.data.id.slice(0, 8)}…)`);
  console.log(`  about:        ${ABOUT.length} chars`);
  console.log(`  constitution: ${CONSTITUTION.length} chars`);
}
main().catch((e) => { console.error(e); process.exit(1); });
