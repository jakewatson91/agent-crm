import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const about = `What it is: a CRM that an AI agent runs for you. The agent finds companies worth reaching, writes the outreach, sends it, and follows up. You step in to approve what goes out and to ask questions when you want them.

How it's built, and why that matters: most CRMs (HubSpot, Salesforce, and the AI tools layered on top of them like Rox and Day) keep your data as rows in big tables. We store it as a graph instead. Every company, person, and fact is its own small piece, linked to the other pieces and to where it came from. That sounds like a detail, but it changes four things you can actually measure.

It costs less to run. When the agent needs to act on a company, we hand it the exact set of linked facts for that task, already assembled. A row-based CRM makes the agent go fetch the company, then its contacts, then its notes as separate steps, and every step runs back through the model and piles on more tokens. In our benchmark, writing one outbound email took us about 2,950 tokens in a single model call. HubSpot, tuned to its leanest, took about 11,100 tokens across four calls. Attio and Day.ai took over 22,000. Same task, same model: the email costs roughly four times less than HubSpot and eight times less than the AI-first tools.

It writes more accurate emails. Because the agent reads small, labeled facts instead of one big record blob, it rarely mistakes an internal note for a real fact about the company. We had a blind judge grade every draft against the known facts. Ours averaged 0.28 made-up claims per email with 78 percent completely clean, against HubSpot at 0.94 and 44 percent. In one case HubSpot pasted an internal "paused until 2100" flag right into an email, and from the same data ours did not. We are clearly ahead of HubSpot and Attio on this. We are about even with a clean newcomer like Twenty, so we don't claim to beat everyone.

You can audit anything with no extra setup. Every change the agent makes is saved as an event, so any fact traces back to the moment it was written: which agent wrote it, what it did, even the prompt behind it. We can also rebuild exactly what the system knew on any past date. HubSpot can do neither. It keeps a list of property changes but no record of who changed them or why, so there is nothing to trace.

Who it is for: early-stage B2B companies in any field, teams of 1 to 20 with no dedicated salesperson, where the founder is doing sales by hand and wants an agent to take outreach off their plate. Also AI-forward B2B SaaS teams of 10 to 200 who are tired of fighting their old CRM.

Voice for outreach: plainspoken and direct. No marketing jargon, no buzzwords, no em dashes. Lead with something concrete.`;

const value_props = [
  'An agent runs your whole outbound, finding companies, writing, sending, and following up, so you get pipeline without hiring an SDR',
  'You approve what goes out in about five minutes a day and the rest runs on its own',
  'It pulls only the linked facts a task needs, so one outbound email cost about four times fewer tokens than HubSpot in our benchmark',
  'It reads small labeled facts instead of a big record blob, so it made about a third as many made-up claims as HubSpot when a blind judge graded the drafts',
  'Every send is saved as an event you can trace back to the exact reason and undo, which a row-based CRM cannot show you',
];

const pain_points = [
  'The founder is still running sales personally and has no time to prospect consistently',
  'Needs more customers but cannot justify a full-time sales hire yet',
  'Outbound is manual and stop-start, so pipeline dries up whenever the team gets busy',
  'Spends more time keeping the CRM updated than actually talking to prospects',
];

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const { data } = await db.from('workspaces').select('policy').eq('id', ws).single();
  const policy = (data!.policy ?? {}) as any;
  policy.drafter = { ...(policy.drafter ?? {}), value_props, pain_points, tone_keywords: ['direct', 'specific', 'plain-spoken', 'no fluff'] };
  const { error } = await db.from('workspaces').update({ about, policy }).eq('id', ws);
  console.log(error ? 'ERR ' + error.message : 'about + value_props + pain_points updated (explained + benchmark-backed)');
})();
