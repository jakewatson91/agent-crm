'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface Workspace {
  id: string;
  name: string;
  persona: Record<string, unknown>;
  icp: Record<string, unknown>;
  budget_cents: number;
  policy: Record<string, unknown>;
  constitution: string;
  about: string;
  knowledge_base: string;
}

const ABOUT_PLACEHOLDER = `What we are: an AI-native CRM optimized for AI workflows.

Who we replace: legacy row-based CRMs (HubSpot, Salesforce). Truly different from "AI on top of legacy" players (Rox, Day) that still center tables and cards.

How we're different: built for the agent as primary user. Information surfaces to humans only when needed, via chat or notification. No tabs to click through.

Who we sell to: early-stage operators who don't want to inherit legacy patterns. YC-stage founders, solo GTM hires, AI-forward sales teams.`;

const KNOWLEDGE_BASE_PLACEHOLDER = `Format each entry as:
- TRIGGERS: <phrases prospects might say in their own words>
  ANGLE: <which of our angles connects to this pain, in 1 sentence>

Examples:

- TRIGGERS: "token bloat", "agent burns through my OpenAI budget", "context window cost"
  ANGLE: agent-native projection sized for agents not humans — 1.28x token efficiency vs reading raw row dumps from HubSpot

- TRIGGERS: "agents overwriting each other", "data silently disappears", "race conditions"
  ANGLE: append-only event log — 0% data loss in our 50-parallel-writers benchmark vs HubSpot's 96%

- TRIGGERS: "agent hallucinates customer details", "can't trust what the bot says", "no audit trail"
  ANGLE: every claim has fact_id + source event chain — recipient can verify any sentence in a draft

- TRIGGERS: "managing GTM with 1-2 people and AI", "lean team plus agents", "no time to babysit dashboards"
  ANGLE: surface info to humans only when policy says so — gates inbox, no dashboards

- TRIGGERS: "Salesforce/HubSpot wasn't built for AI", "bolt-on AI on legacy CRM", "AI on top of tables"
  ANGLE: ground-up architecture for the agent as primary user — events, facts, projections; no retrofitting`;

const CONSTITUTION_PLACEHOLDER = `Voice: smart friend who knows what they're talking about, not a consultant on a slide deck. Casual and confident, not sloppy. Specific and direct.

Writing rules:
- No em dashes. EVER.
- No jargon. If a normal person wouldn't say it out loud, cut it. No "substrate," "primitive," "wedge," "abstraction layer."
- No preamble unless it earns its place.
- No broad sweeping claims without specific evidence.
- Fewer words when fewer will do. Short sentences.
- If it reads like a template, rewrite it.

Substance:
- Always specific. Take a stand on things you believe in.
- Open with the actual signal that prompted reaching out, not a generic intro.
- Reference one concrete fact about the account that justifies the fit.

Don't:
- Pitch features. Describe the problem we solve.
- Send to anyone matching the suppression list.

Hard rules:
- Daily send cap: 50.
- Every claim must cite a fact_id from the active facts list.`;

export default function SettingsPage() {
  const params = useParams<{ ws: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [about, setAbout] = useState('');
  const [constitution, setConstitution] = useState('');
  const [knowledgeBase, setKnowledgeBase] = useState('');
  const [personaText, setPersonaText] = useState('');
  const [icpText, setIcpText] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [budget, setBudget] = useState(0);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/workspace/get?workspace_id=${params.ws}`);
    const j = await r.json();
    if (j.workspace) {
      setWs(j.workspace);
      setAbout(j.workspace.about ?? '');
      setConstitution(j.workspace.constitution ?? '');
      setKnowledgeBase(j.workspace.knowledge_base ?? '');
      setPersonaText(JSON.stringify(j.workspace.persona ?? {}, null, 2));
      setIcpText(JSON.stringify(j.workspace.icp ?? {}, null, 2));
      setPolicyText(JSON.stringify(j.workspace.policy ?? {}, null, 2));
      setBudget(j.workspace.budget_cents ?? 0);
    }
  }
  useEffect(() => { load(); }, [params.ws]);

  async function save() {
    setErr(null); setMsg(null); setSaving(true);
    let persona: Record<string, unknown>;
    let icp: Record<string, unknown>;
    let policy: Record<string, unknown>;
    try {
      persona = JSON.parse(personaText);
      icp = JSON.parse(icpText);
      policy = JSON.parse(policyText);
      for (const [n, v] of [['persona', persona], ['icp', icp], ['policy', policy]] as const) {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${n} must be a JSON object`);
      }
    } catch (e) {
      setErr(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      setSaving(false); return;
    }
    try {
      const r = await fetch('/api/workspace/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws, about, constitution, knowledge_base: knowledgeBase, persona, icp, policy, budget_cents: budget }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'save failed'); return; }
      setMsg(`saved at ${new Date().toLocaleTimeString()}`);
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (!ws) return <section><h2 style={{ marginTop: 0 }}>Constitution</h2><p style={{ color: '#666' }}>loading…</p></section>;

  const proseStyle: React.CSSProperties = {
    width: '100%', padding: '.75rem', background: '#0a0a0a', color: '#e5e5e5',
    border: '1px solid #1f1f1f', fontFamily: 'inherit', fontSize: '.9rem', lineHeight: 1.5,
  };
  const jsonStyle: React.CSSProperties = {
    width: '100%', padding: '.5rem', background: '#0a0a0a', color: '#e5e5e5',
    border: '1px solid #1f1f1f', fontFamily: 'monospace', fontSize: '.85rem',
  };
  const labelStyle: React.CSSProperties = { fontSize: '.85rem', color: '#999', marginBottom: '.25rem', display: 'block' };
  const helpStyle: React.CSSProperties = { fontSize: '.75rem', color: '#666', marginBottom: '.5rem' };

  return (
    <section style={{ maxWidth: 800 }}>
      <h2 style={{ marginTop: 0 }}>Constitution</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>
        Workspace-wide identity and rules of engagement. Every agent reads both fields below before deciding what to do.
        About is what you are; Constitution is how you operate. Per-agent specifics belong in the agent&apos;s description at creation time, not here.
      </p>

      <div style={{ marginTop: '1rem', fontSize: '.85rem' }}>
        <span style={{ color: '#e5e5e5' }}>{ws.name}</span>
        <span style={{ fontSize: '.75rem', color: '#666', marginLeft: '.75rem', fontFamily: 'monospace' }}>{ws.id.slice(0, 8)}…</span>
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <label style={labelStyle}>About</label>
        <div style={helpStyle}>What this company is, what it sells, who it sells to, how it&apos;s different. Used by every agent prompt and (optionally, see below) for similarity matching against new entities.</div>
        <textarea
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          rows={10}
          placeholder={ABOUT_PLACEHOLDER}
          style={proseStyle}
        />
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <label style={labelStyle}>Constitution</label>
        <div style={helpStyle}>Free-form prose. Voice, do-nots, hard rules. Injected into every agent&apos;s system prompt.</div>
        <textarea
          value={constitution}
          onChange={(e) => setConstitution(e.target.value)}
          rows={14}
          placeholder={CONSTITUTION_PLACEHOLDER}
          style={proseStyle}
        />
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <label style={labelStyle}>Knowledge Base (pain → angle map)</label>
        <div style={helpStyle}>The translation layer. List the things prospects say (in their words) next to which of our angles maps to it. Drafters and scorers read this to pick the right framing for any given signal.</div>
        <textarea
          value={knowledgeBase}
          onChange={(e) => setKnowledgeBase(e.target.value)}
          rows={14}
          placeholder={KNOWLEDGE_BASE_PLACEHOLDER}
          style={proseStyle}
        />
      </div>

      <details style={{ marginTop: '2rem', padding: '.5rem 0', borderTop: '1px solid #1f1f1f' }}>
        <summary style={{ cursor: 'pointer', fontSize: '.85rem', color: '#888', padding: '.5rem 0' }}>
          Structured fields (advanced)
        </summary>
        <div style={{ marginTop: '1rem' }}>
          <p style={{ fontSize: '.75rem', color: '#666' }}>
            JSON-shaped fields the system uses for machine-readable lookups (e.g. drafter pre-LLM checks read{' '}
            <code style={{ background: '#1f1f1f', padding: '.1rem .3rem' }}>policy.suppression_list</code> and{' '}
            <code style={{ background: '#1f1f1f', padding: '.1rem .3rem' }}>policy.daily_send_cap</code> directly without an LLM call). The constitution above is for the LLM; these are for code.
          </p>

          <div style={{ marginTop: '1rem' }}>
            <label style={labelStyle}>persona (jsonb)</label>
            <textarea value={personaText} onChange={(e) => setPersonaText(e.target.value)} rows={4} style={jsonStyle} />
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label style={labelStyle}>icp (jsonb)</label>
            <textarea value={icpText} onChange={(e) => setIcpText(e.target.value)} rows={4} style={jsonStyle} />
          </div>

          <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1rem' }}>
            <div>
              <label style={labelStyle}>daily budget (cents)</label>
              <input type="number" min={0} value={budget} onChange={(e) => setBudget(parseInt(e.target.value, 10))} style={{ ...jsonStyle, fontFamily: 'inherit' }} />
            </div>
            <div>
              <label style={labelStyle}>policy (jsonb — suppression_list, daily_send_cap, etc.)</label>
              <textarea value={policyText} onChange={(e) => setPolicyText(e.target.value)} rows={3} style={jsonStyle} />
            </div>
          </div>
        </div>
      </details>

      <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '.75rem' }}>
        <button onClick={save} disabled={saving} style={{ padding: '.5rem 1rem', background: '#9ece6a', color: '#000', border: 'none', cursor: 'pointer', opacity: saving ? 0.4 : 1 }}>
          {saving ? 'saving…' : 'save'}
        </button>
        {msg && <span style={{ color: '#9ece6a', fontSize: '.85rem' }}>✓ {msg}</span>}
        {err && <span style={{ color: '#f7768e', fontSize: '.85rem' }}>✗ {err}</span>}
      </div>
    </section>
  );
}
