'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';

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
}

type Tab = 'setup' | 'email' | 'drafter' | 'routing' | 'integrations' | 'llm' | 'advanced';

const ABOUT_PLACEHOLDER = `What this workspace tracks, who you sell to or want to find, how you want to come across.

Examples:
- "Find B2B SaaS companies hiring GTM roles, draft outreach to founders."
- "Track listings under $500k in Boulder; flag new ones to me."
- "Recruit talent partners for early-stage AI startups."`;

const CONSTITUTION_PLACEHOLDER = `Voice: how the agent should sound when it writes on your behalf.

Hard rules (a few short lines):
- No em dashes.
- No jargon. Plain English.
- Always cite a fact from the active facts list.
- Don't pitch features. Describe the problem we solve.`;

export default function SettingsPage() {
  const params = useParams<{ ws: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<Tab>('setup');

  // Setup tab
  const [about, setAbout] = useState('');
  const [constitution, setConstitution] = useState('');
  const [knowledgeBase, setKnowledgeBase] = useState('');
  const [personaText, setPersonaText] = useState('');
  const [icpText, setIcpText] = useState('');

  // Email tab
  const [overrideTo, setOverrideTo] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [bannedPhrasesText, setBannedPhrasesText] = useState('');
  const [resendKey, setResendKey] = useState('');
  const [resendKeyDirty, setResendKeyDirty] = useState(false);

  // Integrations tab
  const [contactProvider, setContactProvider] = useState<'none' | 'hunter'>('none');
  const [exampleFactsText, setExampleFactsText] = useState('');
  const [bannedPredicatesText, setBannedPredicatesText] = useState('');

  // Drafter tab
  const [subjectStyle, setSubjectStyle] = useState<'one_word' | 'short_phrase' | 'question'>('one_word');
  const [paragraphCount, setParagraphCount] = useState<number>(4);
  const [painPointsText, setPainPointsText] = useState('');
  const [valuePropsText, setValuePropsText] = useState('');
  const [toneKeywordsText, setToneKeywordsText] = useState('');
  const [askExamplesText, setAskExamplesText] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Routing tab
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
  const [routingPreviewOpen, setRoutingPreviewOpen] = useState(false);
  const [routingPreview, setRoutingPreview] = useState<{
    distribution: Record<string, number>;
    samples: Array<{ entity_id: string; entity_name: string; icp_total_now: number; icp_total_reweighted: number; action: string; policy: string; matched_theme?: string | null }>;
    sample_size: number;
  } | null>(null);
  const [routingPreviewLoading, setRoutingPreviewLoading] = useState(false);

  // LLM tab
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiKeyDirty, setOpenaiKeyDirty] = useState(false);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [openrouterKeyDirty, setOpenrouterKeyDirty] = useState(false);
  const [defaultChatModel, setDefaultChatModel] = useState('');
  const [drafterModel, setDrafterModel] = useState('');

  // Advanced
  const [policyText, setPolicyText] = useState('');
  const [budget, setBudget] = useState(0);

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/workspace/get?workspace_id=${params.ws}`);
    const j = await r.json();
    if (j.workspace) {
      const w = j.workspace as Workspace;
      setWs(w);
      setAbout(w.about ?? '');
      setConstitution(w.constitution ?? '');
      setKnowledgeBase(w.knowledge_base ?? '');
      setPersonaText(JSON.stringify(w.persona ?? {}, null, 2));
      setIcpText(JSON.stringify(w.icp ?? {}, null, 2));
      setPolicyText(JSON.stringify(w.policy ?? {}, null, 2));
      setBudget(w.budget_cents ?? 0);
      const policy = (w.policy ?? {}) as Record<string, any>;
      setOverrideTo((policy.outreach?.override_to ?? '') as string);
      setFromEmail((policy.outreach?.from_email ?? '') as string);
      setBannedPhrasesText(((policy.outreach?.banned_phrases ?? []) as string[]).join('\n'));
      setResendKey((policy.outreach?.resend_api_key ?? '') as string);
      setResendKeyDirty(false);
      setContactProvider(((policy.enrichment?.contact_provider as 'none' | 'hunter') ?? 'none'));
      const examples = (policy.enrichment?.example_facts ?? []) as Array<{ predicate: string; object_text: string }>;
      setExampleFactsText(examples.map((f) => `${f.predicate} | ${f.object_text}`).join('\n'));
      setBannedPredicatesText(((policy.enrichment?.banned_predicates ?? []) as string[]).join('\n'));
      const d = (policy.drafter ?? {}) as Record<string, any>;
      setSubjectStyle((d.subject_style as 'one_word' | 'short_phrase' | 'question') ?? 'one_word');
      setParagraphCount(typeof d.paragraph_count === 'number' ? d.paragraph_count : 4);
      setPainPointsText(((d.pain_points ?? []) as string[]).join('\n'));
      setValuePropsText(((d.value_props ?? []) as string[]).join('\n'));
      setToneKeywordsText(((d.tone_keywords ?? []) as string[]).join(', '));
      setAskExamplesText(((d.ask_examples ?? []) as string[]).join('\n'));
      const r = (policy.routing ?? {}) as Record<string, any>;
      setDraftIcp(typeof r.draft_icp_total === 'number' ? r.draft_icp_total : 0.65);
      setDraftSignal(typeof r.draft_signal_strength === 'number' ? r.draft_signal_strength : 0.7);
      setDraftEvidence(typeof r.draft_evidence_depth === 'number' ? r.draft_evidence_depth : 0.5);
      setDraftSuppress(typeof r.draft_suppression_days === 'number' ? r.draft_suppression_days : 14);
      setResearchIcp(typeof r.research_icp_total === 'number' ? r.research_icp_total : 0.5);
      setResearchEvidenceMax(typeof r.research_evidence_depth_max === 'number' ? r.research_evidence_depth_max : 0.4);
      setResearchCooldown(typeof r.research_cooldown_days === 'number' ? r.research_cooldown_days : 7);
      setDropIcp(typeof r.drop_icp_total === 'number' ? r.drop_icp_total : 0.35);
      setDropEvidenceMin(typeof r.drop_evidence_depth_min === 'number' ? r.drop_evidence_depth_min : 0.5);
      setDropSuppress(typeof r.drop_suppression_days === 'number' ? r.drop_suppression_days : 90);
      setWatchIcp(typeof r.watch_icp_total === 'number' ? r.watch_icp_total : 0.5);
      const sc = (policy.scoring ?? {}) as Record<string, any>;
      const wts = (sc.weights ?? {}) as Record<string, any>;
      setWIndustry(typeof wts.industry_match === 'number' ? wts.industry_match : 0.30);
      setWStage(typeof wts.stage_match === 'number' ? wts.stage_match : 0.20);
      setWSignal(typeof wts.signal_strength === 'number' ? wts.signal_strength : 0.10);
      setWEvidence(typeof wts.evidence_depth === 'number' ? wts.evidence_depth : 0.20);
      setWRecency(typeof wts.recency === 'number' ? wts.recency : 0.10);
      setWGraph(typeof wts.graph_proximity === 'number' ? wts.graph_proximity : 0.10);
      setRrfGate(typeof sc.rrf_gate === 'number' ? sc.rrf_gate : 0.30);
      setOpenaiKey((policy.llm?.openai_api_key ?? '') as string);
      setOpenrouterKey((policy.llm?.openrouter_api_key ?? '') as string);
      setOpenaiKeyDirty(false);
      setOpenrouterKeyDirty(false);
      setDefaultChatModel((policy.llm?.default_chat_model ?? '') as string);
      setDrafterModel((policy.llm?.drafter_model ?? '') as string);
    }
  }
  useEffect(() => { load(); }, [params.ws]);

  // Build the policy object we'll persist based on the friendly fields, merging
  // with whatever's currently in the raw policy JSON so unknown keys don't get
  // dropped.
  const composedPolicy = useMemo(() => {
    let base: Record<string, any> = {};
    try { base = JSON.parse(policyText); } catch { base = (ws?.policy ?? {}) as Record<string, any>; }
    const banned = bannedPhrasesText.split('\n').map((s) => s.trim()).filter(Boolean);
    return {
      ...base,
      outreach: {
        ...(base.outreach ?? {}),
        override_to: overrideTo.trim() === '' ? null : overrideTo.trim(),
        from_email: fromEmail.trim() || undefined,
        banned_phrases: banned,
        ...(resendKeyDirty
          ? (resendKey.trim() ? { resend_api_key: resendKey.trim() } : { resend_api_key: undefined })
          : {}),
      },
      enrichment: {
        ...(base.enrichment ?? {}),
        contact_provider: contactProvider,
        example_facts: exampleFactsText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const idx = line.indexOf('|');
            if (idx < 0) return null;
            const predicate = line.slice(0, idx).trim();
            const object_text = line.slice(idx + 1).trim();
            if (!predicate || !object_text) return null;
            return { predicate, object_text };
          })
          .filter((x): x is { predicate: string; object_text: string } => x !== null),
        banned_predicates: bannedPredicatesText.split('\n').map((s) => s.trim()).filter(Boolean),
      },
      drafter: {
        ...(base.drafter ?? {}),
        subject_style: subjectStyle,
        paragraph_count: paragraphCount,
        pain_points: painPointsText.split('\n').map((s) => s.trim()).filter(Boolean),
        value_props: valuePropsText.split('\n').map((s) => s.trim()).filter(Boolean),
        tone_keywords: toneKeywordsText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        ask_examples: askExamplesText.split('\n').map((s) => s.trim()).filter(Boolean),
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
          industry_match: wIndustry,
          stage_match: wStage,
          signal_strength: wSignal,
          evidence_depth: wEvidence,
          recency: wRecency,
          graph_proximity: wGraph,
        },
        rrf_gate: rrfGate,
      },
      llm: {
        ...(base.llm ?? {}),
        ...(openaiKeyDirty
          ? (openaiKey.trim() ? { openai_api_key: openaiKey.trim() } : { openai_api_key: undefined })
          : {}),
        ...(openrouterKeyDirty
          ? (openrouterKey.trim() ? { openrouter_api_key: openrouterKey.trim() } : { openrouter_api_key: undefined })
          : {}),
        default_chat_model: defaultChatModel.trim() || undefined,
        drafter_model: drafterModel.trim() || undefined,
      },
    };
  }, [policyText, overrideTo, fromEmail, bannedPhrasesText, contactProvider, resendKey, resendKeyDirty, openaiKey, openaiKeyDirty, openrouterKey, openrouterKeyDirty, defaultChatModel, drafterModel, exampleFactsText, bannedPredicatesText, subjectStyle, paragraphCount, painPointsText, valuePropsText, toneKeywordsText, askExamplesText, draftIcp, draftSignal, draftEvidence, draftSuppress, researchIcp, researchEvidenceMax, researchCooldown, dropIcp, dropEvidenceMin, dropSuppress, watchIcp, wIndustry, wStage, wSignal, wEvidence, wRecency, wGraph, rrfGate, ws]);

  async function save() {
    setErr(null); setMsg(null); setSaving(true);
    let persona: Record<string, unknown>;
    let icp: Record<string, unknown>;
    try {
      persona = JSON.parse(personaText);
      icp = JSON.parse(icpText);
      for (const [n, v] of [['Tone (persona)', persona], ['Audience (icp)', icp]] as const) {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${n} must be a JSON object`);
      }
    } catch (e) {
      setErr(`invalid JSON in Tone/Audience: ${e instanceof Error ? e.message : String(e)}`);
      setSaving(false); return;
    }

    // Policy: prefer the composed (friendly-fields) object, unless the user is on
    // the Advanced tab and edited the raw JSON.
    let policy: Record<string, any> = composedPolicy;
    if (tab === 'advanced') {
      try {
        policy = JSON.parse(policyText);
        if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
          throw new Error('policy must be a JSON object');
        }
      } catch (e) {
        setErr(`invalid policy JSON: ${e instanceof Error ? e.message : String(e)}`);
        setSaving(false); return;
      }
    }

    try {
      const r = await fetch('/api/workspace/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: params.ws,
          about, constitution, knowledge_base: knowledgeBase,
          persona, icp, policy, budget_cents: budget,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'save failed'); return; }
      setMsg(`saved at ${new Date().toLocaleTimeString()}`);
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (!ws) return <section><h2 style={{ marginTop: 0 }}>Settings</h2><p style={{ color: 'var(--text-3)' }}>loading…</p></section>;

  const proseStyle: React.CSSProperties = {
    width: '100%', padding: '.75rem', background: 'var(--panel)', color: 'var(--text)',
    border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: '.9rem', lineHeight: 1.5, borderRadius: 6,
  };
  const jsonStyle: React.CSSProperties = {
    width: '100%', padding: '.5rem', background: 'var(--panel)', color: 'var(--text)',
    border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: '.85rem', borderRadius: 6,
  };
  const labelStyle: React.CSSProperties = { fontSize: '.85rem', color: 'var(--text-2)', marginBottom: '.25rem', display: 'block', fontWeight: 500 };
  const helpStyle: React.CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: '.5rem' };

  function TabButton({ id, label }: { id: Tab; label: string }) {
    const active = tab === id;
    return (
      <button
        onClick={() => setTab(id)}
        style={{
          padding: '.5rem .9rem', fontSize: '.85rem', cursor: 'pointer',
          background: active ? 'var(--panel-2)' : 'transparent',
          color: active ? 'var(--text)' : 'var(--text-2)',
          border: 'none', borderBottom: active ? '2px solid var(--text)' : '2px solid transparent',
        }}
      >{label}</button>
    );
  }

  return (
    <section style={{ maxWidth: 820 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
        <span>{ws.name}</span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: '.75rem', fontFamily: 'monospace' }}>{ws.id.slice(0, 8)}…</span>
      </div>

      <div style={{ display: 'flex', gap: '.25rem', marginTop: '1.25rem', borderBottom: '1px solid var(--border)' }}>
        <TabButton id="setup" label="Setup" />
        <TabButton id="email" label="Email" />
        <TabButton id="drafter" label="Drafter" />
        <TabButton id="routing" label="Routing" />
        <TabButton id="integrations" label="Integrations" />
        <TabButton id="llm" label="LLM" />
        <TabButton id="advanced" label="Advanced" />
      </div>

      {tab === 'setup' && (
        <div style={{ marginTop: '1.5rem' }}>
          <div>
            <label style={labelStyle}>About</label>
            <div style={helpStyle}>What this workspace does, who you target, what makes you different. Every agent prompt reads this.</div>
            <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={8} placeholder={ABOUT_PLACEHOLDER} style={proseStyle} />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>Writing rules</label>
            <div style={helpStyle}>Voice, do-nots, hard rules. Plain English. Injected into every agent&apos;s system prompt.</div>
            <textarea value={constitution} onChange={(e) => setConstitution(e.target.value)} rows={12} placeholder={CONSTITUTION_PLACEHOLDER} style={proseStyle} />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>Pain → angle map</label>
            <div style={helpStyle}>Optional. List things your target audience says next to which of your angles maps to it. Drafters pick a framing using this.</div>
            <textarea value={knowledgeBase} onChange={(e) => setKnowledgeBase(e.target.value)} rows={10} style={proseStyle} />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>What kind of accounts (structured)</label>
            <div style={helpStyle}>Used by the scorer to rank fit. JSON with whatever keys fit your use case (industry, stage, location, size…).</div>
            <textarea value={icpText} onChange={(e) => setIcpText(e.target.value)} rows={5} style={jsonStyle} />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>Tone (structured)</label>
            <div style={helpStyle}>Short JSON. {`{"pitch": "..."}`} works fine.</div>
            <textarea value={personaText} onChange={(e) => setPersonaText(e.target.value)} rows={4} style={jsonStyle} />
          </div>
        </div>
      )}

      {tab === 'email' && (
        <div style={{ marginTop: '1.5rem' }}>
          <div>
            <label style={labelStyle}>Override recipient</label>
            <div style={helpStyle}>Reroute every approved send to this address (useful while testing). Leave empty to send to the real recipient.</div>
            <input value={overrideTo} onChange={(e) => setOverrideTo(e.target.value)} style={{ ...jsonStyle, fontFamily: 'inherit' }} placeholder="e.g. you@example.com" />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>From address</label>
            <div style={helpStyle}>Defaults to onboarding@resend.dev (no domain verification needed). Set a verified domain address once you have one.</div>
            <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} style={{ ...jsonStyle, fontFamily: 'inherit' }} placeholder="onboarding@resend.dev" />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>Banned phrases</label>
            <div style={helpStyle}>One phrase per line. Stripped from every draft before send (case-insensitive). Stacks on top of the universal jargon list.</div>
            <textarea value={bannedPhrasesText} onChange={(e) => setBannedPhrasesText(e.target.value)} rows={6} style={proseStyle} />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>Resend API key</label>
            <div style={helpStyle}>Stored on this workspace. If empty, the global RESEND_API_KEY env var is used (single-tenant fallback).</div>
            <input
              type="password"
              value={resendKey}
              onChange={(e) => { setResendKey(e.target.value); setResendKeyDirty(true); }}
              style={{ ...jsonStyle, fontFamily: 'inherit' }}
              placeholder="re_..."
            />
          </div>
        </div>
      )}

      {tab === 'drafter' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
            <p style={{ fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5, margin: 0, flex: 1 }}>
              Shape what the cold-email drafter writes. These fields go directly into the drafter's system prompt — pain points become the bullets it picks from in the problem statement, value props become the one-liner options. Tone keywords steer voice.
            </p>
            <button
              type="button"
              onClick={() => {
                setSubjectStyle('one_word');
                setParagraphCount(4);
                setPainPointsText('');
                setValuePropsText('');
                setToneKeywordsText('');
                setAskExamplesText('Worth exploring?\nOpen to a quick chat?');
              }}
              style={{ padding: '.35rem .7rem', fontSize: '.75rem', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
              title="Revert to vertical-neutral defaults"
            >
              Reset to defaults
            </button>
          </div>

          <div>
            <label style={labelStyle}>Subject style</label>
            <div style={helpStyle}>How the email subject line is shaped.</div>
            <select value={subjectStyle} onChange={(e) => setSubjectStyle(e.target.value as 'one_word' | 'short_phrase' | 'question')} style={{ ...jsonStyle, fontFamily: 'inherit' }}>
              <option value="one_word">One word — concrete noun ("Tokens", "Burn")</option>
              <option value="short_phrase">Short phrase — 2-5 words</option>
              <option value="question">Question — short, specific</option>
            </select>
          </div>

          <div>
            <label style={labelStyle}>Body paragraph count</label>
            <div style={helpStyle}>Roughly how many short paragraphs in the body. The drafter still picks pacing — this is a target, not a hard limit.</div>
            <input
              type="number"
              min={1}
              max={8}
              value={paragraphCount}
              onChange={(e) => setParagraphCount(parseInt(e.target.value, 10) || 4)}
              style={{ ...jsonStyle, fontFamily: 'inherit', maxWidth: 120 }}
            />
          </div>

          <div>
            <label style={labelStyle}>Pain points</label>
            <div style={helpStyle}>The specific pains your product addresses. One per line. The drafter picks the one that fits each prospect — don't list them all in the email. Use prospect-recognizable language, not internal jargon.</div>
            <textarea
              value={painPointsText}
              onChange={(e) => setPainPointsText(e.target.value)}
              rows={6}
              placeholder={'Running GTM with 1-2 people on legacy CRMs built for humans\nToken bloat: agents reading raw rows eat 5-10x the tokens they need to'}
              style={proseStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Value props (concrete behaviors / numbers)</label>
            <div style={helpStyle}>One per line. These are the one-liners the drafter can use — concrete, behavioral, ideally with a number. Beats abstract claims every time.</div>
            <textarea
              value={valuePropsText}
              onChange={(e) => setValuePropsText(e.target.value)}
              rows={6}
              placeholder={'When 3 of your agents update the same account at once, all 3 writes land. HubSpot loses 96%.\nEvery line in this email cites a fact you can trace back to where it came from.'}
              style={proseStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Tone keywords</label>
            <div style={helpStyle}>How the email should sound. Comma- or newline-separated.</div>
            <input
              value={toneKeywordsText}
              onChange={(e) => setToneKeywordsText(e.target.value)}
              placeholder="casual, concrete, no-jargon, short-sentences"
              style={{ ...jsonStyle, fontFamily: 'inherit' }}
            />
          </div>

          <div>
            <label style={labelStyle}>Ask examples</label>
            <div style={helpStyle}>One per line. The drafter picks one or rephrases. Short — never a paragraph.</div>
            <textarea
              value={askExamplesText}
              onChange={(e) => setAskExamplesText(e.target.value)}
              rows={4}
              placeholder={'Worth exploring?\nOpen to a 15-min chat?\nWant to see it run?'}
              style={proseStyle}
            />
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <button
              type="button"
              onClick={async () => {
                if (previewOpen && previewText) { setPreviewOpen(false); return; }
                setPreviewLoading(true);
                try {
                  const r = await fetch('/api/admin/preview-prompt', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      subject_style: subjectStyle,
                      paragraph_count: paragraphCount,
                      pain_points: painPointsText.split('\n').map((s) => s.trim()).filter(Boolean),
                      value_props: valuePropsText.split('\n').map((s) => s.trim()).filter(Boolean),
                      tone_keywords: toneKeywordsText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
                      ask_examples: askExamplesText.split('\n').map((s) => s.trim()).filter(Boolean),
                      forbidden_phrases: bannedPhrasesText.split('\n').map((s) => s.trim()).filter(Boolean),
                    }),
                  });
                  const j = await r.json();
                  setPreviewText(j.prompt ?? '(no preview)');
                  setPreviewOpen(true);
                } finally { setPreviewLoading(false); }
              }}
              style={{ padding: '.45rem .9rem', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem' }}
            >
              {previewLoading ? 'rendering…' : previewOpen ? 'Hide preview' : 'Preview prompt'}
            </button>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: '.35rem' }}>
              Renders what the drafter LLM will actually be told, with your current form values. Save to make it live.
            </div>
            {previewOpen && previewText && (
              <pre style={{ marginTop: '.75rem', padding: '.75rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '.75rem', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 480, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
                {previewText}
              </pre>
            )}
          </div>
        </div>
      )}

      {tab === 'routing' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
            <p style={{ fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5, margin: 0, flex: 1 }}>
              Tune when the agent drafts, watches, researches, or drops an entity. Higher draft thresholds = pickier (fewer drafts). Lower drop thresholds = give up on entities faster.
            </p>
            <button
              type="button"
              onClick={() => {
                setDraftIcp(0.65); setDraftSignal(0.7); setDraftEvidence(0.5); setDraftSuppress(14);
                setResearchIcp(0.5); setResearchEvidenceMax(0.4); setResearchCooldown(7);
                setDropIcp(0.35); setDropEvidenceMin(0.5); setDropSuppress(90);
                setWatchIcp(0.5);
                setWIndustry(0.30); setWStage(0.20); setWSignal(0.10);
                setWEvidence(0.20); setWRecency(0.10); setWGraph(0.10);
                setRrfGate(0.30);
              }}
              style={{ padding: '.35rem .7rem', fontSize: '.75rem', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
              title="Revert to code defaults"
            >
              Reset to defaults
            </button>
          </div>

          <div>
            <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.4rem' }}>Draft</div>
            <div style={helpStyle}>Entity gets a draft when ALL of these clear.</div>
            <NumRow label="icp_total min" value={draftIcp} onChange={setDraftIcp} step={0.05} />
            <NumRow label="signal_strength min" value={draftSignal} onChange={setDraftSignal} step={0.05} />
            <NumRow label="evidence_depth min" value={draftEvidence} onChange={setDraftEvidence} step={0.05} />
            <NumRow label="suppression days (don't re-draft within N days)" value={draftSuppress} onChange={setDraftSuppress} step={1} />
          </div>

          <div>
            <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.4rem' }}>Deep research</div>
            <div style={helpStyle}>Entity gets a targeted research pull (Exa) when fit hints exist but evidence is thin.</div>
            <NumRow label="icp_total min" value={researchIcp} onChange={setResearchIcp} step={0.05} />
            <NumRow label="evidence_depth max (research if below this)" value={researchEvidenceMax} onChange={setResearchEvidenceMax} step={0.05} />
            <NumRow label="cooldown days (don't re-research within N days)" value={researchCooldown} onChange={setResearchCooldown} step={1} />
          </div>

          <div>
            <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.4rem' }}>Drop</div>
            <div style={helpStyle}>Confidently off-ICP. Suppresses re-evaluation for N days.</div>
            <NumRow label="icp_total max (drop if below)" value={dropIcp} onChange={setDropIcp} step={0.05} />
            <NumRow label="evidence_depth min (need enough facts to be sure)" value={dropEvidenceMin} onChange={setDropEvidenceMin} step={0.05} />
            <NumRow label="suppression days" value={dropSuppress} onChange={setDropSuppress} step={1} />
          </div>

          <div>
            <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.4rem' }}>Watch</div>
            <div style={helpStyle}>Fit is real but trigger is weak. Keep enriching, no draft.</div>
            <NumRow label="icp_total min" value={watchIcp} onChange={setWatchIcp} step={0.05} />
          </div>

          <div>
            <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.4rem' }}>Scoring weights</div>
            <div style={helpStyle}>How each sub-score contributes to the final icp_total. Should roughly sum to 1.0 — anything beyond that gets clamped to [0,1] anyway.</div>
            <NumRow label="industry_match" value={wIndustry} onChange={setWIndustry} step={0.05} />
            <NumRow label="stage_match" value={wStage} onChange={setWStage} step={0.05} />
            <NumRow label="signal_strength" value={wSignal} onChange={setWSignal} step={0.05} />
            <NumRow label="evidence_depth" value={wEvidence} onChange={setWEvidence} step={0.05} />
            <NumRow label="recency" value={wRecency} onChange={setWRecency} step={0.05} />
            <NumRow label="graph_proximity" value={wGraph} onChange={setWGraph} step={0.05} />
            <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: '.5rem' }}>
              sum: {(wIndustry + wStage + wSignal + wEvidence + wRecency + wGraph).toFixed(2)}
            </div>
          </div>

          <div>
            <NumRow label="RRF prefilter gate (skip LLM scoring when fused similarity below this)" value={rrfGate} onChange={setRrfGate} step={0.05} />
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <button
              type="button"
              onClick={async () => {
                if (routingPreviewOpen && routingPreview) { setRoutingPreviewOpen(false); return; }
                setRoutingPreviewLoading(true);
                try {
                  const r = await fetch('/api/admin/routing-preview', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      workspace_id: params.ws,
                      routing: {
                        draft_icp_total: draftIcp, draft_signal_strength: draftSignal,
                        draft_evidence_depth: draftEvidence, draft_suppression_days: draftSuppress,
                        research_icp_total: researchIcp, research_evidence_depth_max: researchEvidenceMax,
                        research_cooldown_days: researchCooldown,
                        drop_icp_total: dropIcp, drop_evidence_depth_min: dropEvidenceMin, drop_suppression_days: dropSuppress,
                        watch_icp_total: watchIcp,
                      },
                      scoring: {
                        weights: { industry_match: wIndustry, stage_match: wStage, signal_strength: wSignal, evidence_depth: wEvidence, recency: wRecency, graph_proximity: wGraph },
                        rrf_gate: rrfGate,
                      },
                      limit: 30,
                    }),
                  });
                  const j = await r.json();
                  setRoutingPreview(j);
                  setRoutingPreviewOpen(true);
                } finally { setRoutingPreviewLoading(false); }
              }}
              style={{ padding: '.45rem .9rem', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem' }}
            >
              {routingPreviewLoading ? 'running…' : routingPreviewOpen ? 'Hide preview' : 'Preview: what would happen?'}
            </button>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: '.35rem' }}>
              Runs the action selector against the top 30 entities with your current thresholds + weights. Read-only — no facts get written.
            </div>

            {routingPreviewOpen && routingPreview && (
              <div style={{ marginTop: '.75rem', display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
                <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
                  {Object.entries(routingPreview.distribution).sort((a, b) => b[1] - a[1]).map(([action, count]) => (
                    <div key={action} style={{ padding: '.3rem .6rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '.8rem' }}>
                      <strong>{count}</strong> <span style={{ color: 'var(--text-3)' }}>{action}</span>
                    </div>
                  ))}
                  <div style={{ padding: '.3rem .6rem', fontSize: '.8rem', color: 'var(--text-3)' }}>
                    of {routingPreview.sample_size}
                  </div>
                </div>

                <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <table style={{ width: '100%', fontSize: '.75rem', borderCollapse: 'collapse' }}>
                    <thead style={{ background: 'var(--panel-2)' }}>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '.4rem .6rem', borderBottom: '1px solid var(--border)' }}>entity</th>
                        <th style={{ textAlign: 'right', padding: '.4rem .6rem', borderBottom: '1px solid var(--border)' }}>now</th>
                        <th style={{ textAlign: 'right', padding: '.4rem .6rem', borderBottom: '1px solid var(--border)' }}>new</th>
                        <th style={{ textAlign: 'left', padding: '.4rem .6rem', borderBottom: '1px solid var(--border)' }}>action / policy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routingPreview.samples.map((s) => (
                        <tr key={s.entity_id}>
                          <td style={{ padding: '.35rem .6rem', borderBottom: '1px solid var(--border)' }}>{s.entity_name}</td>
                          <td style={{ padding: '.35rem .6rem', borderBottom: '1px solid var(--border)', textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{s.icp_total_now.toFixed(2)}</td>
                          <td style={{ padding: '.35rem .6rem', borderBottom: '1px solid var(--border)', textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: s.icp_total_reweighted > s.icp_total_now ? '#48a' : s.icp_total_reweighted < s.icp_total_now ? '#a48' : 'inherit' }}>{s.icp_total_reweighted.toFixed(2)}</td>
                          <td style={{ padding: '.35rem .6rem', borderBottom: '1px solid var(--border)' }}>
                            <strong>{s.action}</strong>
                            <span style={{ color: 'var(--text-3)' }}> · {s.policy}</span>
                            {s.matched_theme && <span style={{ color: 'var(--text-3)' }}> · theme={s.matched_theme}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'integrations' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div>
            <label style={labelStyle}>Contact lookups</label>
            <div style={helpStyle}>When the enricher finds an account with a domain, should it pull contacts via Hunter? Defaults to none.</div>
            <select value={contactProvider} onChange={(e) => setContactProvider(e.target.value as 'none' | 'hunter')} style={{ ...jsonStyle, fontFamily: 'inherit' }}>
              <option value="none">none</option>
              <option value="hunter">hunter</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Custom connectors</label>
            <div style={helpStyle}>Wire a new HTTP source by URL + a plain-English description of what to extract. The agent runs it on a schedule and the LLM does the extraction — no code.</div>
            <a href={`/workspace/${params.ws}/connectors/new`} style={{ display: 'inline-block', marginTop: '.5rem', padding: '.5rem .9rem', background: 'var(--accent)', color: 'var(--accent-fg)', borderRadius: 6, textDecoration: 'none', fontSize: '.85rem', fontWeight: 500 }}>+ Add connector</a>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem' }}>
              <label style={labelStyle}>Enricher examples</label>
              <button
                type="button"
                onClick={() => { setExampleFactsText(''); setBannedPredicatesText(''); }}
                style={{ padding: '.25rem .55rem', fontSize: '.7rem', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer' }}
                title="Clear examples + banned predicates"
              >
                Reset
              </button>
            </div>
            <div style={helpStyle}>What kinds of facts should the agent look for when reading signals about an entity? One per line in the form <code>predicate | example value</code>. The LLM uses these as exemplars — extracted facts don't have to match exactly. Leave empty for vertical-neutral defaults.</div>
            <textarea
              value={exampleFactsText}
              onChange={(e) => setExampleFactsText(e.target.value)}
              rows={8}
              placeholder={'hiring_for | SDR / AE / RevOps role being filled\nraised_round | Series A $12M led by Sequoia\nlaunched_product | specific product or feature'}
              style={proseStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Banned enricher predicates</label>
            <div style={helpStyle}>Predicates the enricher must NEVER assert (e.g. low-info or noisy ones). One per line. Stacks on top of the always-banned list (<code>is_company</code>, <code>exists</code>, etc.).</div>
            <textarea
              value={bannedPredicatesText}
              onChange={(e) => setBannedPredicatesText(e.target.value)}
              rows={4}
              style={proseStyle}
            />
          </div>
        </div>
      )}

      {tab === 'llm' && (
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <p style={{ fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
            Paste API keys for this workspace. When set, these override the server's env vars for every call originating in this workspace (drafter, scoring, intake chat). Embedding still runs on OpenAI — leave the OpenAI key set even if you're routing chat through OpenRouter.
          </p>

          <div>
            <label style={labelStyle}>OpenAI API key</label>
            <div style={helpStyle}>Used for bare model ids (e.g. <code>gpt-4o-mini</code>) AND for all text embeddings. Leave empty to use the server's OPENAI_API_KEY env var.</div>
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => { setOpenaiKey(e.target.value); setOpenaiKeyDirty(true); }}
              style={{ ...jsonStyle, fontFamily: 'inherit' }}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>

          <div>
            <label style={labelStyle}>OpenRouter API key</label>
            <div style={helpStyle}>Used for slash-prefixed model ids (e.g. <code>deepseek/deepseek-v4-pro</code>, <code>anthropic/claude-sonnet-4-6</code>). Leave empty to use the server's OPENROUTER_API_KEY env var.</div>
            <input
              type="password"
              value={openrouterKey}
              onChange={(e) => { setOpenrouterKey(e.target.value); setOpenrouterKeyDirty(true); }}
              style={{ ...jsonStyle, fontFamily: 'inherit' }}
              placeholder="sk-or-..."
              autoComplete="off"
            />
          </div>

          <div>
            <label style={labelStyle}>Default chat model</label>
            <div style={helpStyle}>Override the workspace-wide default for non-drafter LLM calls (enricher, scoring, intake). Leave empty to keep the code default (<code>deepseek/deepseek-v4-flash:free</code>).</div>
            <input
              value={defaultChatModel}
              onChange={(e) => setDefaultChatModel(e.target.value)}
              style={{ ...jsonStyle, fontFamily: 'inherit' }}
              placeholder="deepseek/deepseek-v4-flash:free"
            />
          </div>

          <div>
            <label style={labelStyle}>Drafter model</label>
            <div style={helpStyle}>Override the model the drafter uses specifically. This is the customer-facing output, so quality matters. Leave empty to keep the code default (<code>deepseek/deepseek-v4-pro</code>).</div>
            <input
              value={drafterModel}
              onChange={(e) => setDrafterModel(e.target.value)}
              style={{ ...jsonStyle, fontFamily: 'inherit' }}
              placeholder="deepseek/deepseek-v4-pro"
            />
          </div>
        </div>
      )}

      {tab === 'advanced' && (
        <div style={{ marginTop: '1.5rem' }}>
          <p style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
            Raw policy JSON. Edits on this tab take precedence over the friendly fields on Email / Integrations when you save.
          </p>

          <div style={{ marginTop: '.75rem' }}>
            <label style={labelStyle}>policy (jsonb)</label>
            <textarea value={policyText} onChange={(e) => setPolicyText(e.target.value)} rows={14} style={jsonStyle} />
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>daily budget (cents)</label>
            <input type="number" min={0} value={budget} onChange={(e) => setBudget(parseInt(e.target.value, 10))} style={{ ...jsonStyle, fontFamily: 'inherit' }} />
          </div>
        </div>
      )}

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

function NumRow({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', padding: '.25rem 0' }}>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        style={{
          width: 90, padding: '.35rem .5rem', background: 'var(--panel)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: '.8rem',
        }}
      />
      <span style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>{label}</span>
    </div>
  );
}
