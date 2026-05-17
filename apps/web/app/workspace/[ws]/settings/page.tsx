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

type Tab = 'setup' | 'email' | 'integrations' | 'llm' | 'advanced';

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
      enrichment: { ...(base.enrichment ?? {}), contact_provider: contactProvider },
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
  }, [policyText, overrideTo, fromEmail, bannedPhrasesText, contactProvider, resendKey, resendKeyDirty, openaiKey, openaiKeyDirty, openrouterKey, openrouterKeyDirty, defaultChatModel, drafterModel, ws]);

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
