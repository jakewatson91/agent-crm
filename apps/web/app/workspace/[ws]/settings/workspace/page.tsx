'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { HelpRow } from '../_components/HelpRow';
import { ChipList } from '../_components/ChipList';

interface Workspace {
  id: string;
  name: string;
  persona: Record<string, unknown>;
  icp: Record<string, unknown>;
  budget_cents: number;
  policy: Record<string, any>;
  constitution: string;
  about: string;
  knowledge_base: string;
  created_at?: string;
  updated_at?: string;
}

type Tab = 'about' | 'writing' | 'research' | 'thresholds';

interface Angle {
  id: string;
  label: string;
  query_template: string;
  domain_scope: 'own_site' | 'news' | 'open_web';
  recency_days?: number;
  num_results?: number;
  enabled?: boolean;
}

const ABOUT_PLACEHOLDER = `Plain English. What you do, who you sell to, how the agent should come across. Everything structured (ICP, persona, pain points, example facts) is derived from this when you save.

Example:
"We sell an agent-native CRM to founder-led startups doing $0–5M ARR who are running sales with one person or no one. Buyers are usually the founder. They care about: dropping HubSpot/Salesforce, agent reliability, cost per outbound, not training-wheel features. Voice: plainspoken, direct, no marketing jargon, no em dashes, lead with concrete numbers."`;

const WRITING_PLACEHOLDER = `Voice and hard rules. Plain English. The agent reads this on every prompt.

Example:
- Plainspoken, no jargon, no em dashes.
- Subjects are short phrases, not questions.
- Bodies are 2–3 short paragraphs.
- Always cite a specific fact about the company.
- Don't pitch features. Describe the problem we solve.
- Sign off with first name only.`;

const RESEARCH_PLACEHOLDER = `Plain English. What's worth knowing about a prospect that would make outreach land?

Example:
"Dig up what they shipped recently, who they sell to (customer logos, case studies), and any leadership changes. We sell to eng-led teams, so their engineering blog and tech choices matter. Skip generic funding-announcement noise unless it's a fresh round."`;

export default function SettingsWorkspacePage() {
  const params = useParams<{ ws: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<Tab>('about');

  const [about, setAbout] = useState('');
  const [aboutAtLoad, setAboutAtLoad] = useState('');

  const [constitution, setConstitution] = useState('');
  const [bannedPhrases, setBannedPhrases] = useState<string[]>([]);

  const [draftIcp, setDraftIcp] = useState(0.65);
  const [draftSignal, setDraftSignal] = useState(0.7);
  const [draftEvidence, setDraftEvidence] = useState(0.5);
  const [draftSuppress, setDraftSuppress] = useState(14);
  const [researchIcp, setResearchIcp] = useState(0.5);
  const [researchEvidenceMax, setResearchEvidenceMax] = useState(0.4);
  const [researchCooldown, setResearchCooldown] = useState(7);
  const [dropIcp, setDropIcp] = useState(0.35);
  const [dropEvidenceMin, setDropEvidenceMin] = useState(0.5);
  const [dropSuppress, setDropSuppress] = useState(90);
  const [watchIcp, setWatchIcp] = useState(0.5);
  const [wIndustry, setWIndustry] = useState(0.30);
  const [wStage, setWStage] = useState(0.20);
  const [wSignal, setWSignal] = useState(0.10);
  const [wEvidence, setWEvidence] = useState(0.20);
  const [wRecency, setWRecency] = useState(0.10);
  const [wGraph, setWGraph] = useState(0.10);
  const [rrfGate, setRrfGate] = useState(0.30);
  const [contactProvider, setContactProvider] = useState<'none' | 'hunter'>('none');
  const [hunterCap, setHunterCap] = useState<number>(0);
  const [budget, setBudget] = useState(0);

  const [hireIncludeFamilies, setHireIncludeFamilies] = useState<string[]>([]);
  const [hireIncludeSeniorities, setHireIncludeSeniorities] = useState<string[]>([]);
  const [hireExcludeFamilies, setHireExcludeFamilies] = useState<string[]>([]);
  const [hireAlwaysExec, setHireAlwaysExec] = useState<boolean>(false);

  const [outreachChannel, setOutreachChannel] = useState<'email' | 'linkedin'>('email');
  const [fromEmail, setFromEmail] = useState('');
  const [overrideTo, setOverrideTo] = useState('');

  // Research strategy
  const [guidance, setGuidance] = useState('');
  const [guidanceAtLoad, setGuidanceAtLoad] = useState('');
  const [alwaysInclude, setAlwaysInclude] = useState<string[]>([]);
  const [alwaysIncludeAtLoad, setAlwaysIncludeAtLoad] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<Angle[]>([]);
  const [strategyAt, setStrategyAt] = useState<string | null>(null);
  const [regen, setRegen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/workspace/get?workspace_id=${params.ws}`);
    const j = await r.json();
    if (!j.workspace) return;
    const w = j.workspace as Workspace;
    setWs(w);
    setAbout(w.about ?? '');
    setAboutAtLoad(w.about ?? '');
    setConstitution(w.constitution ?? '');
    const policy = (w.policy ?? {}) as Record<string, any>;
    const out = (policy.outreach ?? {}) as Record<string, any>;
    setOverrideTo((out.override_to ?? '') as string);
    setFromEmail((out.from_email ?? '') as string);
    setBannedPhrases(((out.banned_phrases ?? []) as string[]));
    const dr = (policy.drafter ?? {}) as Record<string, any>;
    setOutreachChannel((dr.outreach_channel === 'linkedin' ? 'linkedin' : 'email'));
    const enr = (policy.enrichment ?? {}) as Record<string, any>;
    setContactProvider(((enr.contact_provider as 'none' | 'hunter') ?? 'none'));
    setHunterCap(typeof enr.hunter_monthly_cap === 'number' ? enr.hunter_monthly_cap : 0);
    const rt = (policy.routing ?? {}) as Record<string, any>;
    setDraftIcp(num(rt.draft_icp_total, 0.65));
    setDraftSignal(num(rt.draft_signal_strength, 0.7));
    setDraftEvidence(num(rt.draft_evidence_depth, 0.5));
    setDraftSuppress(num(rt.draft_suppression_days, 14));
    setResearchIcp(num(rt.research_icp_total, 0.5));
    setResearchEvidenceMax(num(rt.research_evidence_depth_max, 0.4));
    setResearchCooldown(num(rt.research_cooldown_days, 7));
    setDropIcp(num(rt.drop_icp_total, 0.35));
    setDropEvidenceMin(num(rt.drop_evidence_depth_min, 0.5));
    setDropSuppress(num(rt.drop_suppression_days, 90));
    setWatchIcp(num(rt.watch_icp_total, 0.5));
    const sc = (policy.scoring ?? {}) as Record<string, any>;
    const wts = (sc.weights ?? {}) as Record<string, any>;
    setWIndustry(num(wts.industry_match, 0.30));
    setWStage(num(wts.stage_match, 0.20));
    setWSignal(num(wts.signal_strength, 0.10));
    setWEvidence(num(wts.evidence_depth, 0.20));
    setWRecency(num(wts.recency, 0.10));
    setWGraph(num(wts.graph_proximity, 0.10));
    setRrfGate(num(sc.rrf_gate, 0.30));
    const hf = (policy.hiring_filter ?? {}) as Record<string, any>;
    setHireIncludeFamilies(Array.isArray(hf.include_families) ? hf.include_families : []);
    setHireIncludeSeniorities(Array.isArray(hf.include_seniorities) ? hf.include_seniorities : []);
    setHireExcludeFamilies(Array.isArray(hf.exclude_families) ? hf.exclude_families : []);
    setHireAlwaysExec(Boolean(hf.always_include_exec));
    const rs = (policy.research ?? {}) as Record<string, any>;
    setGuidance((rs.guidance ?? '') as string);
    setGuidanceAtLoad((rs.guidance ?? '') as string);
    setAlwaysInclude(Array.isArray(rs.always_include) ? rs.always_include : []);
    setAlwaysIncludeAtLoad(Array.isArray(rs.always_include) ? rs.always_include : []);
    setStrategy(Array.isArray(rs.strategy) ? (rs.strategy as Angle[]) : []);
    setStrategyAt((rs.strategy_generated_at ?? null) as string | null);
    setBudget(w.budget_cents ?? 0);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params.ws]);

  const composedPolicy = useMemo(() => {
    const base = (ws?.policy ?? {}) as Record<string, any>;
    return {
      ...base,
      outreach: {
        ...(base.outreach ?? {}),
        override_to: overrideTo.trim() === '' ? null : overrideTo.trim(),
        from_email: fromEmail.trim() || undefined,
        banned_phrases: bannedPhrases,
      },
      drafter: {
        ...(base.drafter ?? {}),
        outreach_channel: outreachChannel,
      },
      enrichment: {
        ...(base.enrichment ?? {}),
        contact_provider: contactProvider,
        hunter_monthly_cap: hunterCap > 0 ? hunterCap : undefined,
      },
      routing: {
        ...(base.routing ?? {}),
        draft_icp_total: draftIcp,
        draft_signal_strength: draftSignal,
        draft_evidence_depth: draftEvidence,
        draft_suppression_days: draftSuppress,
        research_icp_total: researchIcp,
        research_evidence_depth_max: researchEvidenceMax,
        research_cooldown_days: researchCooldown,
        drop_icp_total: dropIcp,
        drop_evidence_depth_min: dropEvidenceMin,
        drop_suppression_days: dropSuppress,
        watch_icp_total: watchIcp,
      },
      scoring: {
        ...(base.scoring ?? {}),
        weights: {
          industry_match: wIndustry, stage_match: wStage, signal_strength: wSignal,
          evidence_depth: wEvidence, recency: wRecency, graph_proximity: wGraph,
        },
        rrf_gate: rrfGate,
      },
      hiring_filter: {
        ...(base.hiring_filter ?? {}),
        include_families: hireIncludeFamilies,
        include_seniorities: hireIncludeSeniorities,
        exclude_families: hireExcludeFamilies,
        always_include_exec: hireAlwaysExec,
      },
      research: {
        ...(base.research ?? {}),
        guidance: guidance.trim() || undefined,
        always_include: alwaysInclude,
        // Persist the angle list so per-angle on/off toggles survive a save. The
        // planner overwrites this when guidance/About changes.
        strategy,
        strategy_generated_at: strategyAt ?? undefined,
      },
    };
  }, [
    ws,
    outreachChannel, overrideTo, fromEmail, bannedPhrases,
    contactProvider, hunterCap,
    draftIcp, draftSignal, draftEvidence, draftSuppress,
    researchIcp, researchEvidenceMax, researchCooldown,
    dropIcp, dropEvidenceMin, dropSuppress, watchIcp,
    wIndustry, wStage, wSignal, wEvidence, wRecency, wGraph, rrfGate,
    hireIncludeFamilies, hireIncludeSeniorities, hireExcludeFamilies, hireAlwaysExec,
    guidance, alwaysInclude, strategy, strategyAt,
  ]);

  async function save() {
    setErr(null); setMsg(null); setSaving(true);
    try {
      const aboutChanged = about.trim() !== aboutAtLoad.trim() && about.trim().length > 0;

      let icp: Record<string, unknown> | undefined;
      let persona: Record<string, unknown> | undefined;
      let knowledgeBase: string | undefined;
      let policyOverride = composedPolicy as Record<string, any>;
      if (aboutChanged) {
        const r = await fetch('/api/workspaces/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: params.ws, about }),
        });
        if (r.ok) {
          const j = await r.json() as { derived?: any };
          const d = j.derived ?? {};
          icp = d.icp;
          persona = d.persona;
          knowledgeBase = d.knowledge_base;
          policyOverride = {
            ...policyOverride,
            enrichment: {
              ...(policyOverride.enrichment ?? {}),
              example_facts: Array.isArray(d.example_facts) ? d.example_facts : (policyOverride.enrichment?.example_facts ?? []),
            },
            drafter: {
              ...(policyOverride.drafter ?? {}),
              pain_points: Array.isArray(d.pain_points) ? d.pain_points : (policyOverride.drafter?.pain_points ?? []),
              value_props: Array.isArray(d.value_props) ? d.value_props : (policyOverride.drafter?.value_props ?? []),
              tone_keywords: Array.isArray(d.tone_keywords) ? d.tone_keywords : (policyOverride.drafter?.tone_keywords ?? []),
            },
          };
        }
      }

      const r = await fetch('/api/workspace/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: params.ws,
          about, constitution,
          ...(knowledgeBase !== undefined ? { knowledge_base: knowledgeBase } : {}),
          ...(icp !== undefined ? { icp } : {}),
          ...(persona !== undefined ? { persona } : {}),
          policy: policyOverride,
          budget_cents: budget,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'save failed'); return; }
      // When About / research guidance / must-include terms changed, refresh the AI
      // search plan from the now-saved values so it stays in sync automatically.
      const researchChanged = aboutChanged
        || guidance.trim() !== guidanceAtLoad.trim()
        || JSON.stringify(alwaysInclude) !== JSON.stringify(alwaysIncludeAtLoad);
      if (researchChanged) {
        await fetch('/api/workspaces/research-strategy', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: params.ws }),
        }).catch(() => {});
      }
      setMsg(aboutChanged
        ? `saved + regenerated structured fields at ${new Date().toLocaleTimeString()}`
        : researchChanged ? `saved + refreshed research plan at ${new Date().toLocaleTimeString()}`
        : `saved at ${new Date().toLocaleTimeString()}`);
      await load();
    } finally { setSaving(false); }
  }

  function toggleAngle(id: string) {
    setStrategy((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: a.enabled === false } : a)));
  }

  async function regenerateStrategy() {
    setRegen(true); setErr(null);
    try {
      const r = await fetch('/api/workspaces/research-strategy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? 'regenerate failed'); return; }
      await load();
    } finally { setRegen(false); }
  }

  if (!ws) return <div><h2 style={{ marginTop: 0 }}>Workspace</h2><p style={{ color: 'var(--text-3)' }}>loading…</p></div>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Workspace</h2>
      <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
        <span>{ws.name}</span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: '.75rem', fontFamily: 'monospace' }}>{ws.id.slice(0, 8)}…</span>
      </div>

      <div style={{ display: 'flex', gap: '.25rem', marginTop: '1.25rem', borderBottom: '1px solid var(--border)' }}>
        <Tab id="about" current={tab} onClick={setTab} label="About" />
        <Tab id="writing" current={tab} onClick={setTab} label="Writing style" />
        <Tab id="research" current={tab} onClick={setTab} label="Research" />
        <Tab id="thresholds" current={tab} onClick={setTab} label="Thresholds" />
      </div>

      {tab === 'about' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <HelpRow label="About" help="What you do, who you sell to, how the agent should sound. Plain English. When you save, the agent re-derives the structured fields (ICP, persona, pain points, example facts, tone) from this text automatically.">
            <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={18} placeholder={ABOUT_PLACEHOLDER} style={prose} />
          </HelpRow>
        </div>
      )}

      {tab === 'writing' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <HelpRow label="Writing style" help="Voice rules + hard do-nots. Plain English. The agent reads this on every prompt. Subject style, paragraph count, ask phrasing, tone — all belong here as prose rather than separate fields.">
            <textarea value={constitution} onChange={(e) => setConstitution(e.target.value)} rows={14} placeholder={WRITING_PLACEHOLDER} style={prose} />
          </HelpRow>

          <HelpRow label="Banned phrases" help="Hard list of phrases the drafter must never produce. Stripped silently before posting. Stacks on top of code-level defaults.">
            <ChipList values={bannedPhrases} onChange={setBannedPhrases} placeholder="e.g. hope this finds you well" />
          </HelpRow>

          <HelpRow label="Outreach channel" help="Email drafts a full cold email with subject + body. LinkedIn drafts a connection request (max 250 chars, no subject).">
            <div style={{ display: 'flex', gap: '.75rem' }}>
              {(['email', 'linkedin'] as const).map((ch) => (
                <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: '.35rem', fontSize: '.85rem', cursor: 'pointer' }}>
                  <input type="radio" name="outreach_channel" value={ch} checked={outreachChannel === ch} onChange={() => setOutreachChannel(ch)} />
                  {ch === 'email' ? 'Email' : 'LinkedIn'}
                </label>
              ))}
            </div>
          </HelpRow>

          <HelpRow label="From address" help="The address outbound is sent from. Defaults to onboarding@resend.dev (no domain verification needed).">
            <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="onboarding@resend.dev" style={textInput} />
          </HelpRow>

          <HelpRow label="Override recipient (dev redirect)" help="Reroute every approved send to this address while testing. Leave empty to send to the real recipient.">
            <input value={overrideTo} onChange={(e) => setOverrideTo(e.target.value)} placeholder="you@example.com" style={textInput} />
          </HelpRow>

          <div style={{ padding: '.5rem .75rem', borderRadius: 6, background: 'var(--panel-2)', fontSize: '.72rem', color: 'var(--text-3)' }}>
            Your Resend API key lives in <strong>Developer → Environment variables</strong> as <code>RESEND_API_KEY</code>.
          </div>
        </div>
      )}

      {tab === 'research' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            The agent plans its own web searches per prospect from your About text and the guidance below, then runs them within a fixed budget. You give direction; it writes and tunes the actual searches.
          </div>

          <HelpRow label="What to research" help="Plain English: what should the agent dig up about a prospect beyond hiring? e.g. recent launches, who they sell to, leadership changes, security posture. This shapes the searches the agent writes.">
            <textarea value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={7} placeholder={RESEARCH_PLACEHOLDER} style={prose} />
          </HelpRow>

          <HelpRow label="Always include" help="Specific topics or terms every search plan must cover. Optional. Leave empty to let the agent decide entirely.">
            <ChipList values={alwaysInclude} onChange={setAlwaysInclude} placeholder="e.g. SOC 2, Series B, new VP of Sales" />
          </HelpRow>

          <div style={{ marginTop: '.5rem', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 500, color: 'var(--text-2)' }}>Current search plan</div>
            {strategyAt && <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>generated {new Date(strategyAt).toLocaleString()}</span>}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            AI-written. Toggle one off to stop running it. To change the queries, edit the guidance above and regenerate — they aren&apos;t hand-edited.
          </div>

          {strategy.length === 0 ? (
            <p style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>No plan yet. Save your About text, or click Regenerate to build one now.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
              {strategy.map((a) => {
                const on = a.enabled !== false;
                return (
                  <div key={a.id} style={{ display: 'flex', gap: '.6rem', alignItems: 'flex-start', padding: '.5rem .6rem', borderRadius: 6, border: '1px solid var(--border)', background: on ? 'var(--panel-2)' : 'transparent', opacity: on ? 1 : 0.5 }}>
                    <input type="checkbox" checked={on} onChange={() => toggleAngle(a.id)} style={{ marginTop: '.15rem' }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '.82rem', color: 'var(--text)' }}>
                        {a.label}
                        <code style={{ marginLeft: '.5rem', fontSize: '.68rem', color: 'var(--text-3)' }}>{a.domain_scope}{a.recency_days ? ` · ${a.recency_days}d` : ''}</code>
                      </div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', fontFamily: 'monospace', wordBreak: 'break-word' }}>{a.query_template}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div>
            <button onClick={regenerateStrategy} disabled={regen} style={{ padding: '.4rem .8rem', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', opacity: regen ? 0.4 : 1, fontFamily: 'inherit', fontSize: '.8rem' }}>
              {regen ? 'regenerating…' : 'Regenerate plan from saved settings'}
            </button>
            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: '.35rem' }}>
              Uses your saved About + guidance. Save first if you just edited them. Toggles are stored with the page&apos;s Save button.
            </div>
          </div>
        </div>
      )}

      {tab === 'thresholds' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            Numeric levers. Defaults are sensible — only touch these if the agent&apos;s behavior isn&apos;t matching what you want.
          </div>

          <HelpRow label="Score needed to draft outbound" help="An account must reach this composite score before the drafter writes a touch. Range 0–1.">
            <NumInput value={draftIcp} onChange={setDraftIcp} step={0.05} />
          </HelpRow>
          <HelpRow label="Signal strength needed to draft" help="The signal driving the draft must be at least this strong.">
            <NumInput value={draftSignal} onChange={setDraftSignal} step={0.05} />
          </HelpRow>
          <HelpRow label="Evidence depth needed to draft" help="How much fact evidence (cosine to ICP) an account needs before drafting.">
            <NumInput value={draftEvidence} onChange={setDraftEvidence} step={0.05} />
          </HelpRow>
          <HelpRow label="Days to suppress after a draft" help="After we draft to an account, don't draft again for this many days unless something material changes.">
            <NumInput value={draftSuppress} onChange={setDraftSuppress} step={1} />
          </HelpRow>

          <HelpRow label="Score needed to spend on research" help="Above this score the agent will run deeper research on the account.">
            <NumInput value={researchIcp} onChange={setResearchIcp} step={0.05} />
          </HelpRow>
          <HelpRow label="Evidence depth ceiling for research" help="Don't research accounts that already have this much evidence.">
            <NumInput value={researchEvidenceMax} onChange={setResearchEvidenceMax} step={0.05} />
          </HelpRow>
          <HelpRow label="Days between research runs" help="Per-entity research cooldown.">
            <NumInput value={researchCooldown} onChange={setResearchCooldown} step={1} />
          </HelpRow>

          <HelpRow label="Score below which we drop the account" help="Accounts below this score get suppressed instead of being kept on watch.">
            <NumInput value={dropIcp} onChange={setDropIcp} step={0.05} />
          </HelpRow>
          <HelpRow label="Evidence floor before we'll drop" help="Don't drop an account until it has at least this much evidence.">
            <NumInput value={dropEvidenceMin} onChange={setDropEvidenceMin} step={0.05} />
          </HelpRow>
          <HelpRow label="Days to suppress dropped accounts" help="How long a dropped account stays quiet before the agent reconsiders.">
            <NumInput value={dropSuppress} onChange={setDropSuppress} step={1} />
          </HelpRow>
          <HelpRow label="Score above which we keep watching" help="Accounts at this score stay on watch but don't trigger drafts yet.">
            <NumInput value={watchIcp} onChange={setWatchIcp} step={0.05} />
          </HelpRow>

          <div style={{ marginTop: '.75rem', fontSize: '.78rem', fontWeight: 500, color: 'var(--text-2)' }}>Scoring weights</div>
          <HelpRow label="Industry match" help="How much industry match counts in the composite score."><NumInput value={wIndustry} onChange={setWIndustry} step={0.05} /></HelpRow>
          <HelpRow label="Stage match" help="How much stage match counts."><NumInput value={wStage} onChange={setWStage} step={0.05} /></HelpRow>
          <HelpRow label="Signal strength" help="How much raw signal strength counts."><NumInput value={wSignal} onChange={setWSignal} step={0.05} /></HelpRow>
          <HelpRow label="Evidence depth" help="How much fact evidence counts."><NumInput value={wEvidence} onChange={setWEvidence} step={0.05} /></HelpRow>
          <HelpRow label="Recency" help="How much recent activity counts."><NumInput value={wRecency} onChange={setWRecency} step={0.05} /></HelpRow>
          <HelpRow label="Graph proximity" help="How much closeness to existing customers counts."><NumInput value={wGraph} onChange={setWGraph} step={0.05} /></HelpRow>
          <HelpRow label="Minimum ICP-match strength to count as evidence" help="Facts below this cosine similarity to your ICP description are ignored for scoring."><NumInput value={rrfGate} onChange={setRrfGate} step={0.05} /></HelpRow>

          <div style={{ marginTop: '.75rem', fontSize: '.78rem', fontWeight: 500, color: 'var(--text-2)' }}>Enrichment</div>
          <HelpRow label="Contact provider" help="Where to look up email addresses. 'none' disables contact lookups entirely.">
            <select value={contactProvider} onChange={(e) => setContactProvider(e.target.value as 'none' | 'hunter')} style={textInput}>
              <option value="none">none</option>
              <option value="hunter">Hunter.io</option>
            </select>
          </HelpRow>
          <HelpRow label="Hunter monthly cap" help="Hard cap on Hunter lookups per calendar month. 0 means no cap.">
            <NumInput value={hunterCap} onChange={setHunterCap} step={1} />
          </HelpRow>
          <HelpRow label="Daily budget (cents)" help="Token-spend ceiling per day for this workspace.">
            <input type="number" min={0} value={budget} onChange={(e) => setBudget(parseInt(e.target.value, 10) || 0)} style={{ ...textInput, width: 140 }} />
          </HelpRow>

          <div style={{ marginTop: '.75rem', fontSize: '.78rem', fontWeight: 500, color: 'var(--text-2)' }}>Hiring filter</div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            ATS postings the agent should care about. Leave a section empty to include everything. Postings outside these filters never become signals (no fact extraction, no tokens).
          </div>
          <HelpRow label="Include role families" help="Only postings classified into these role families become signals. Empty = include all families.">
            <TaxonomyMultiSelect options={ROLE_FAMILY_OPTIONS} value={hireIncludeFamilies} onChange={setHireIncludeFamilies} />
          </HelpRow>
          <HelpRow label="Include seniorities" help="Only postings at these seniority levels become signals. Empty = include all seniorities.">
            <TaxonomyMultiSelect options={ROLE_SENIORITY_OPTIONS} value={hireIncludeSeniorities} onChange={setHireIncludeSeniorities} />
          </HelpRow>
          <HelpRow label="Always include exec roles" help="If checked, VP+ / Head-of / C-level roles always pass, even if their seniority isn't in the include list above.">
            <input type="checkbox" checked={hireAlwaysExec} onChange={(e) => setHireAlwaysExec(e.target.checked)} />
          </HelpRow>
          <HelpRow label="Exclude role families" help="Always drop postings classified into these families (overrides include). Useful for filtering out engineering hires at companies that don't sell to engineers.">
            <TaxonomyMultiSelect options={ROLE_FAMILY_OPTIONS} value={hireExcludeFamilies} onChange={setHireExcludeFamilies} />
          </HelpRow>
        </div>
      )}

      <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '.75rem' }}>
        <button onClick={save} disabled={saving} style={{ padding: '.5rem 1rem', background: '#9ece6a', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: saving ? 0.4 : 1 }}>
          {saving ? 'saving…' : 'save'}
        </button>
        {msg && <span style={{ color: '#9ece6a', fontSize: '.85rem' }}>✓ {msg}</span>}
        {err && <span style={{ color: '#f7768e', fontSize: '.85rem' }}>✗ {err}</span>}
      </div>
    </div>
  );
}

function num(v: unknown, def: number): number { return typeof v === 'number' ? v : def; }

const ROLE_FAMILY_OPTIONS: string[] = [
  'sales', 'gtm', 'revops', 'growth', 'customer_success', 'marketing',
  'engineering', 'product', 'design', 'data', 'ml_ai',
  'ops', 'finance', 'people', 'legal', 'founder', 'other',
];
const ROLE_SENIORITY_OPTIONS: string[] = [
  'ic_junior', 'ic_mid', 'ic_senior', 'lead', 'manager', 'director', 'vp', 'cxo', 'unknown',
];

function TaxonomyMultiSelect({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  function toggle(opt: string) {
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem' }}>
      {options.map((opt) => {
        const on = value.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            style={{
              padding: '.25rem .6rem',
              fontSize: '.75rem',
              borderRadius: 999,
              cursor: 'pointer',
              border: on ? '1px solid var(--text)' : '1px solid var(--border)',
              background: on ? 'var(--text)' : 'var(--bg)',
              color: on ? 'var(--bg)' : 'var(--text-2)',
              fontFamily: 'inherit',
            }}
          >{opt}</button>
        );
      })}
    </div>
  );
}

function Tab({ id, current, onClick, label }: { id: Tab; current: Tab; onClick: (s: Tab) => void; label: string }) {
  const active = current === id;
  return (
    <button
      onClick={() => onClick(id)}
      style={{
        padding: '.5rem .9rem', fontSize: '.85rem', cursor: 'pointer',
        background: active ? 'var(--panel-2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-2)',
        border: 'none', borderBottom: active ? '2px solid var(--text)' : '2px solid transparent',
      }}
    >{label}</button>
  );
}

function NumInput({ value, onChange, step }: { value: number; onChange: (v: number) => void; step: number }) {
  return (
    <input
      type="number" step={step} value={value}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
      style={{ ...textInput, width: 100 }}
    />
  );
}

const prose: React.CSSProperties = {
  width: '100%', padding: '.75rem', background: 'var(--bg)', color: 'var(--text)',
  border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: '.9rem', lineHeight: 1.55, borderRadius: 6,
};
const textInput: React.CSSProperties = {
  padding: '.4rem .6rem', background: 'var(--bg)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.85rem',
};
