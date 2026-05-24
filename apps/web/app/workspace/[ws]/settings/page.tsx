'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { HelpRow } from './_components/HelpRow';
import { ChipList } from './_components/ChipList';
import { EnvVarsEditor } from './_components/EnvVarsEditor';
import { DeveloperView } from './_components/DeveloperView';
import { ConnectedServices } from './_components/ConnectedServices';
import { MembersSection } from './_components/MembersSection';
import { ApiKeysSection } from './_components/ApiKeysSection';

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

type Section = 'about' | 'writing' | 'thresholds' | 'connections' | 'members' | 'api_keys';

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

export default function SettingsPage() {
  const params = useParams<{ ws: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [section, setSection] = useState<Section>('about');

  // About — single prose box
  const [about, setAbout] = useState('');
  const [aboutAtLoad, setAboutAtLoad] = useState('');

  // Writing style — constitution + banned phrases
  const [constitution, setConstitution] = useState('');
  const [bannedPhrases, setBannedPhrases] = useState<string[]>([]);

  // Thresholds — numeric levers
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

  // Hiring filter — workspace-wide ATS connector filter on classified role
  // family / seniority. Empty = include everything (preserves prior behavior).
  const [hireIncludeFamilies, setHireIncludeFamilies] = useState<string[]>([]);
  const [hireIncludeSeniorities, setHireIncludeSeniorities] = useState<string[]>([]);
  const [hireExcludeFamilies, setHireExcludeFamilies] = useState<string[]>([]);
  const [hireAlwaysExec, setHireAlwaysExec] = useState<boolean>(false);

  // Outbound send addressing (not "writing style" but practical)
  const [fromEmail, setFromEmail] = useState('');
  const [overrideTo, setOverrideTo] = useState('');

  // Env vars + developer view
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [devUnlocked, setDevUnlocked] = useState(false);
  const [devPolicy, setDevPolicy] = useState<Record<string, unknown>>({});

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
    setDevPolicy(policy);
    const out = (policy.outreach ?? {}) as Record<string, any>;
    setOverrideTo((out.override_to ?? '') as string);
    setFromEmail((out.from_email ?? '') as string);
    setBannedPhrases(((out.banned_phrases ?? []) as string[]));
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
    setBudget(w.budget_cents ?? 0);
    setEnvVars((policy.env ?? {}) as Record<string, string>);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params.ws]);

  // Compose policy from friendly state OR pass through devPolicy if unlocked.
  // Derived fields (icp / persona / pain_points / etc.) are NOT computed here —
  // they come from the auto-derive step at save time when About changes.
  const composedPolicy = useMemo(() => {
    if (devUnlocked) return devPolicy;
    const base = (ws?.policy ?? {}) as Record<string, any>;
    return {
      ...base,
      outreach: {
        ...(base.outreach ?? {}),
        override_to: overrideTo.trim() === '' ? null : overrideTo.trim(),
        from_email: fromEmail.trim() || undefined,
        banned_phrases: bannedPhrases,
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
      env: filterEmpty(envVars),
    };
  }, [
    devUnlocked, devPolicy, ws,
    overrideTo, fromEmail, bannedPhrases,
    contactProvider, hunterCap,
    draftIcp, draftSignal, draftEvidence, draftSuppress,
    researchIcp, researchEvidenceMax, researchCooldown,
    dropIcp, dropEvidenceMin, dropSuppress, watchIcp,
    wIndustry, wStage, wSignal, wEvidence, wRecency, wGraph, rrfGate,
    hireIncludeFamilies, hireIncludeSeniorities, hireExcludeFamilies, hireAlwaysExec,
    envVars,
  ]);

  async function save() {
    setErr(null); setMsg(null); setSaving(true);
    try {
      const aboutChanged = !devUnlocked && about.trim() !== aboutAtLoad.trim() && about.trim().length > 0;

      // Auto-derive on About change. Silent — user doesn't see the wizard step.
      // The derived fields (icp/persona/pain_points/etc.) update the top-level
      // workspace columns AND the policy.drafter/enrichment lists.
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
      setMsg(aboutChanged
        ? `saved + regenerated structured fields at ${new Date().toLocaleTimeString()}`
        : `saved at ${new Date().toLocaleTimeString()}`);
      await load();
    } finally { setSaving(false); }
  }

  if (!ws) return <section><h2 style={{ marginTop: 0 }}>Settings</h2><p style={{ color: 'var(--text-3)' }}>loading…</p></section>;

  return (
    <section style={{ maxWidth: 820 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
        <span>{ws.name}</span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: '.75rem', fontFamily: 'monospace' }}>{ws.id.slice(0, 8)}…</span>
      </div>

      {devUnlocked && (
        <div style={{ marginTop: '1rem', padding: '.5rem .75rem', borderRadius: 6, background: '#3a1a1a', color: '#f7c5c5', fontSize: '.78rem' }}>
          Developer view is unlocked. The forms below are read-only — re-lock at the bottom to edit them.
        </div>
      )}

      <div style={{ display: 'flex', gap: '.25rem', marginTop: '1.25rem', borderBottom: '1px solid var(--border)' }}>
        <SectionTab id="about" current={section} onClick={setSection} label="About" />
        <SectionTab id="writing" current={section} onClick={setSection} label="Writing style" />
        <SectionTab id="thresholds" current={section} onClick={setSection} label="Thresholds" />
        <SectionTab id="connections" current={section} onClick={setSection} label="Connections" />
        <SectionTab id="members" current={section} onClick={setSection} label="Members" />
        <SectionTab id="api_keys" current={section} onClick={setSection} label="API keys" />
      </div>

      <fieldset disabled={devUnlocked} style={{ border: 0, padding: 0, margin: 0, opacity: devUnlocked ? 0.5 : 1 }}>
        {section === 'about' && (
          <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <HelpRow label="About" help="What you do, who you sell to, how the agent should sound. Plain English. When you save, the agent re-derives the structured fields (ICP, persona, pain points, example facts, tone) from this text automatically.">
              <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={18} placeholder={ABOUT_PLACEHOLDER} style={prose} />
            </HelpRow>
          </div>
        )}

        {section === 'writing' && (
          <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <HelpRow label="Writing style" help="Voice rules + hard do-nots. Plain English. The agent reads this on every prompt. Subject style, paragraph count, ask phrasing, tone — all belong here as prose rather than separate fields.">
              <textarea value={constitution} onChange={(e) => setConstitution(e.target.value)} rows={14} placeholder={WRITING_PLACEHOLDER} style={prose} />
            </HelpRow>

            <HelpRow label="Banned phrases" help="Hard list of phrases the drafter must never produce. Stripped silently before posting. Stacks on top of code-level defaults.">
              <ChipList values={bannedPhrases} onChange={setBannedPhrases} placeholder="e.g. hope this finds you well" />
            </HelpRow>

            <HelpRow label="From address" help="The address outbound is sent from. Defaults to onboarding@resend.dev (no domain verification needed).">
              <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="onboarding@resend.dev" style={textInput} />
            </HelpRow>

            <HelpRow label="Override recipient (dev redirect)" help="Reroute every approved send to this address while testing. Leave empty to send to the real recipient.">
              <input value={overrideTo} onChange={(e) => setOverrideTo(e.target.value)} placeholder="you@example.com" style={textInput} />
            </HelpRow>

            <div style={{ padding: '.5rem .75rem', borderRadius: 6, background: 'var(--panel-2)', fontSize: '.72rem', color: 'var(--text-3)' }}>
              Your Resend API key lives in <strong>Environment variables</strong> below as <code>RESEND_API_KEY</code>.
            </div>
          </div>
        )}

        {section === 'thresholds' && (
          <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              Numeric levers. Defaults are sensible — only touch these if the agent's behavior isn&apos;t matching what you want.
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

        {section === 'connections' && (
          <div style={{ marginTop: '1.5rem' }}>
            <ConnectedServices workspace_id={ws.id} />
          </div>
        )}

        {section === 'members' && (
          <div style={{ marginTop: '1.5rem' }}>
            <MembersSection workspace_id={ws.id} />
          </div>
        )}

        {section === 'api_keys' && (
          <div style={{ marginTop: '1.5rem' }}>
            <ApiKeysSection workspace_id={ws.id} />
          </div>
        )}
      </fieldset>

      <div style={{ marginTop: '2rem' }}>
        <details open style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.5rem .75rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '.85rem', color: 'var(--text-2)' }}>
            Environment variables
            <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: '.5rem' }}>
              keys + model overrides. Fill in only the ones you want to set per workspace; empty rows fall through to env.
            </span>
          </summary>
          <div style={{ marginTop: '.75rem' }}>
            <EnvVarsEditor value={envVars} onChange={setEnvVars} />
          </div>
        </details>
      </div>

      <div style={{ marginTop: '.75rem' }}>
        <DeveloperView
          policy={composedPolicy}
          workspaceMeta={{ id: ws.id, created_at: ws.created_at, updated_at: ws.updated_at }}
          unlocked={devUnlocked}
          onUnlockChange={setDevUnlocked}
          onPolicyChange={setDevPolicy}
        />
      </div>

      <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '.75rem' }}>
        <button onClick={save} disabled={saving} style={{ padding: '.5rem 1rem', background: '#9ece6a', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: saving ? 0.4 : 1 }}>
          {saving ? 'saving…' : 'save'}
        </button>
        {msg && <span style={{ color: '#9ece6a', fontSize: '.85rem' }}>✓ {msg}</span>}
        {err && <span style={{ color: '#f7768e', fontSize: '.85rem' }}>✗ {err}</span>}
      </div>
    </section>
  );
}

function filterEmpty(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k && v && v.length) out[k] = v;
  }
  return out;
}

function num(v: unknown, def: number): number { return typeof v === 'number' ? v : def; }

// Taxonomy options mirror packages/tools/src/classify_role.ts. Kept in sync by
// hand — the classifier values are the source of truth; mismatched values
// here are silently ignored by passesHiringFilter.
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

function SectionTab({ id, current, onClick, label }: { id: Section; current: Section; onClick: (s: Section) => void; label: string }) {
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
