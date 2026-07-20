import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

const templates = [
  {
    id: 't1_connectors',
    label: 'For connectors: pure personalization (Trigger + soft Think; no cred, no ask)',
    audience: 'connectors: analysts, media, community voices with reach but no direct buyer role (e.g. Chi Odogwu, Hernan Lopez)',
    body: "Hey Hernán, caught your latest Streamonomics piece, vertical hitting $150B in 2026 got my attention. I'm on the video-delivery-economics side of this world, so your data work is required reading. Which slice of that $118B do you think grows fastest over the next 2–3 years?",
    anatomy: 'Trigger: latest Streamonomics piece + his $150B-in-2026 stat · Think: which slice of the $118B grows fastest next 2–3 years (market-level, extends his own number) · Cred: none by design · Talk: none by design — reply is the win',
    notes: 'Bump if silent: no DM; leave a substantive comment on their content instead.',
    enabled: true,
  },
  {
    id: 't2_founder',
    label: 'Founder/CEO first touch: personalization + problem + product + "solved already?" (two-step)',
    audience: 'founders and CEOs, first touch',
    body: "Hey Anatolii, caught your StrictlyVC point on producing 10x faster. As the audience scales, does your delivery cost per viewer fall, or does the cost line grow 1:1 with it? For most platforms it's 1:1 forever. We built a small script that offloads a chunk of that delivery, no stack change. Already got that handled?",
    anatomy: 'Trigger: StrictlyVC 10x-faster point · Think: cost per viewer falls or grows 1:1 with audience (margin register, binary = easy to answer) · Cred: "for most platforms it\'s 1:1 forever" (pattern claim) · Talk: "Already got that handled?" (status-quo exit, soft — pitch stays one sentence, two-step by design)',
    follow_up: "Makes sense. The easiest way to know is a 2-week measurement on your web traffic, offload % shows up in your own CDN dashboard, no commitment. We've been doing this with vertical teams; takes a small script, nothing else changes. Want me to scope it?",
    notes: 'Bump if silent: Day 4, value re-touch (the follow_up DM).',
    enabled: true,
  },
  {
    id: 't3_technical',
    label: 'Verified technical owner: full 4Ts (technical buyer)',
    audience: 'verified technical owners: engineering or infrastructure leaders who own video delivery',
    body: "Hey Hanjo, saw you're hiring video-delivery eng, traffic must be scaling. How much of your egress is the same segments, over and over? Delivery is ~98% of infra spend (AWS's own VOD table), and that repeat share is a cost most teams can't even see. We built a small script + service worker that offloads it between viewers, no player or origin change. Want me to put your numbers to it? Offload % shows in your CDN dashboard.",
    anatomy: 'Trigger: video-delivery eng job post → bridge: traffic is scaling · Think: how much of egress is repeat segments (binary-ish, answerable) · Cred: ~98% of infra spend (AWS\'s own VOD table) + the repeat share as an UNSEEN cost — impact first, the visibility gap is the credibility jab, not the impact claim · Talk: "Want me to put your numbers to it?" — question-first, verification detail (their own CDN dashboard) rides behind it',
    notes: 'May run to ~420 characters; the service-worker detail earns its keep with technical buyers. docs.sudden.network goes in reply #2 for this template only, never in DM #1. Bump if silent: Day 4, disclose scope: web HLS VOD today, native on roadmap.',
    enabled: true,
  },
  {
    id: 't4_discovery',
    label: 'Personalization + problem + discovery CTA (one-step)',
    audience: 'kept for reference, do not use',
    body: "Hey Anatolii, loved the StrictlyVC bit on shipping a show in 3 months. As My Drama scales past 85M users, what keeps delivery cost from scaling with every viewer? On most CDN bills ~98% is delivery, and it explodes each time an episode drops. We run 30-min discovery sessions with vertical teams to size exactly that. Open to one?",
    anatomy: 'Trigger · Think · Cred · Talk (discovery)',
    enabled: false,
  },
];

const message_rules = [
  "Structure: Trigger | Think | Cred | Talk, in that order. Follow the chosen template's anatomy; some templates stop after Think by design.",
  'Aim for under 400 characters (about 50 to 75 words). Template 3 may run to ~420 when the technical detail earns its keep.',
  'The Think slot is a question the recipient can actually answer, ideally binary or near-binary.',
  'No links in a first message.',
];

const cr_note = "Hey {FirstName}, caught {trigger: your post on X / the Y launch / the Z interview}. I'm on the video delivery-economics side of that world, would love to connect. (Include the note only when confident of the accept.)";

async function main() {
  const { data: w, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (w!.policy ?? {}) as Record<string, unknown>;
  const drafter = (policy.drafter ?? {}) as Record<string, unknown>;
  policy.drafter = {
    ...drafter,
    outreach_channel: 'linkedin',
    templates,
    message_rules,
    char_budget: 400,
    cr_note,
  };
  const { error: upErr } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (upErr) throw upErr;
  console.log('updated. drafter keys:', Object.keys(policy.drafter as object).join(', '));
  console.log('templates:', templates.map((t) => `${t.id}(${t.enabled ? 'on' : 'off'})`).join(', '));
}
main().catch((e) => { console.error(e); process.exit(1); });
