/**
 * Grade the "derive an argument from the About text" prompt without writing to
 * the database.
 *
 * The question this answers: the wizard asks a new customer for one paragraph
 * about what they sell, and derives eleven policy fields from it. Every one of
 * those is a COMPONENT of a message. None of them is the argument, so the
 * drafter had to improvise the link on every message, and on Sudden it reached
 * the same wrong conclusion 26 times. Sudden's argument had to be typed into
 * scripts/_cfg_sudden_arguments.ts by hand, which no customer can do.
 *
 * So: can the paragraph produce the argument, if the model is asked properly?
 * Run this and read the output. Sudden's known-good answer is a new release
 * driving catch-up viewing through the OLD seasons, with the ask being the back
 * catalogue and the premiere left alone. The known-bad answer, and the one the
 * drafter reached unaided, is "let us carry your premiere."
 *
 *   npx tsx scripts/_dryrun_arguments.ts          # all fixtures, 3 samples each
 *   npx tsx scripts/_dryrun_arguments.ts sudden 5 # one fixture, 5 samples
 *
 * The two non-Sudden fixtures are here to catch a prompt that only works on the
 * vertical it was written against. They are test inputs and stay in this file;
 * nothing vertical-specific goes near the shipped prompt.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { ARGUMENTS_PROMPT, sanitizeArguments } from '../apps/web/app/api/workspaces/_derive_arguments';

const SUDDEN_WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const FIXTURES: Record<string, string> = {
  lab: `We buy used lab equipment from biotech companies that are shutting down or upgrading, refurbish it, certify it, and resell it with a one year warranty at about 40% of the price of new. Centrifuges, sequencers, mass specs, freezers. We sell to early stage biotech and academic labs who need working equipment now and cannot wait a quarter for a purchase order to clear. We also buy: if a lab has equipment sitting idle we pay cash for it within a week. The buyer is usually a lab manager or a head of operations.`,

  support: `We make customer support software that answers tickets in the customer's own language. An online shop writes their help articles once in English, and our system answers a shopper in German, Portuguese or Japanese using those articles, and hands off to a human when it is not confident. We sell to online retailers who ship internationally. The pain is that they open a new country, orders come in, and the support queue fills with a language nobody on the team reads. The buyer is a head of customer experience or a COO.`,
};

async function loadSudden(): Promise<string> {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.from('workspaces').select('about').eq('id', SUDDEN_WS).maybeSingle();
  if (error) throw error;
  return ((data as any)?.about ?? '') as string;
}

async function sample(about: string): Promise<unknown> {
  const r = await chatComplete({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: ARGUMENTS_PROMPT },
      { role: 'user', content: `Customer description:\n${about}` },
    ],
    response_format: { type: 'json_object' },
    // Must track deriveArguments in _derive_arguments.ts or this grades a
    // different call than the one that ships.
    max_tokens: 4000,
  });
  return JSON.parse(r.text);
}

(async () => {
  const only = process.argv[2];
  const n = Number(process.argv[3] ?? 3);

  const cases: Array<[string, string]> = [];
  if (!only || only === 'sudden') cases.push(['sudden', await loadSudden()]);
  for (const [k, v] of Object.entries(FIXTURES)) if (!only || only === k) cases.push([k, v]);

  for (const [name, about] of cases) {
    console.log(`\n${'='.repeat(72)}\n${name.toUpperCase()}  (${n} samples)\n${'='.repeat(72)}`);
    for (let i = 0; i < n; i++) {
      try {
        const args = sanitizeArguments(await sample(about));
        console.log(`\n--- sample ${i + 1}: ${args.length} argument(s) ---`);
        for (const a of args) {
          console.log(`  label   : ${a.label}`);
          console.log(`  when    : ${a.when}`);
          console.log(`  only_if : ${a.only_if}`);
          console.log(`  so      : ${a.so}`);
          console.log(`  ask     : ${a.ask}\n`);
        }
      } catch (e) {
        console.log(`\n--- sample ${i + 1}: FAILED ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
