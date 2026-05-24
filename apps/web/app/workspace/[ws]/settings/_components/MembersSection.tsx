'use client';

import { useCallback, useEffect, useState } from 'react';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

interface Member {
  user_id: string;
  email: string;
  role: Role;
  created_at: string;
  is_self: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  created_at: string;
}

const ROLE_OPTIONS: Role[] = ['admin', 'member', 'viewer']; // for invites + role changes (owner promotion handled separately)

export function MembersSection({ workspace_id }: { workspace_id: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [viewerRole, setViewerRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [mr, ir] = await Promise.all([
      fetch(`/api/workspace/members/list?workspace_id=${workspace_id}`).then((r) => r.json()),
      fetch(`/api/workspace/invitations/list?workspace_id=${workspace_id}`).then((r) => r.json()),
    ]);
    setMembers(mr.members ?? []);
    setViewerRole(mr.viewer_role ?? null);
    setInvites(ir.invitations ?? []);
    setLoading(false);
  }, [workspace_id]);

  useEffect(() => { load(); }, [load]);

  const canManage = viewerRole === 'owner' || viewerRole === 'admin';

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await fetch('/api/workspace/members/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, email: inviteEmail, role: inviteRole }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'invite failed'); return; }
      if (j.email_sent) setMsg(`invited ${inviteEmail}`);
      else setMsg(`invited ${inviteEmail} (email failed: ${j.email_error ?? 'unknown'}; share link: ${j.accept_url})`);
      setInviteEmail('');
      await load();
    } finally { setBusy(false); }
  }

  async function changeRole(user_id: string, role: Role) {
    setErr(null); setMsg(null);
    const r = await fetch('/api/workspace/members/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id, user_id, role }),
    });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? 'update failed'); return; }
    await load();
  }

  async function removeMember(user_id: string, email: string) {
    if (!confirm(`Remove ${email} from this workspace?`)) return;
    const r = await fetch('/api/workspace/members/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id, user_id }),
    });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? 'remove failed'); return; }
    await load();
  }

  async function revokeInvite(id: string) {
    const r = await fetch('/api/workspace/invitations/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) { const j = await r.json(); setErr(j.error ?? 'revoke failed'); return; }
    await load();
  }

  if (loading) return <p style={{ color: 'var(--text-3)' }}>loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Invite form */}
      {canManage && (
        <form onSubmit={invite} style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="email"
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="email to invite"
            style={inputStyle}
          />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} style={inputStyle}>
            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit" disabled={busy || !inviteEmail} style={primaryBtn(busy || !inviteEmail)}>
            {busy ? 'sending…' : 'invite'}
          </button>
          {msg && <span style={{ color: '#9ece6a', fontSize: '.8rem' }}>✓ {msg}</span>}
          {err && <span style={{ color: '#f7768e', fontSize: '.8rem' }}>{err}</span>}
        </form>
      )}

      {/* Members list */}
      <div>
        <div style={sectionLabel}>Members</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          {members.map((m) => (
            <div key={m.user_id} style={memberRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '.92rem' }}>
                  {m.email || <span style={{ color: 'var(--text-3)' }}>(no email)</span>}
                  {m.is_self && <span style={{ marginLeft: '.5rem', fontSize: '.7rem', color: 'var(--text-3)' }}>(you)</span>}
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'monospace' }}>{m.user_id.slice(0, 8)}…</div>
              </div>
              {viewerRole === 'owner' && !m.is_self ? (
                <select value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value as Role)} style={{ ...inputStyle, width: 110 }}>
                  {(['owner', 'admin', 'member', 'viewer'] as Role[]).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              ) : (
                <span style={roleBadge(m.role)}>{m.role}</span>
              )}
              {canManage && !m.is_self && (
                <button onClick={() => removeMember(m.user_id, m.email)} style={dangerBtn}>remove</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div>
          <div style={sectionLabel}>Pending invitations</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
            {invites.map((inv) => (
              <div key={inv.id} style={memberRow}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '.92rem' }}>{inv.email}</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                    expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <span style={roleBadge(inv.role)}>{inv.role}</span>
                {canManage && (
                  <button onClick={() => revokeInvite(inv.id)} style={dangerBtn}>revoke</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '.4rem .6rem', background: 'var(--bg)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.85rem',
};
const sectionLabel: React.CSSProperties = {
  fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: '.4rem',
};
const memberRow: React.CSSProperties = {
  display: 'flex', gap: '.6rem', alignItems: 'center',
  padding: '.55rem .75rem', border: '1px solid var(--border)', borderRadius: 6,
};
const dangerBtn: React.CSSProperties = {
  padding: '.3rem .6rem', background: 'transparent', color: '#f7768e',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: '.75rem',
};
function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '.4rem .8rem', background: '#9ece6a', color: '#000',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
    opacity: disabled ? 0.4 : 1, fontWeight: 500,
  };
}
function roleBadge(role: Role): React.CSSProperties {
  const color = role === 'owner' ? '#bb9af7' : role === 'admin' ? '#7aa2f7' : role === 'member' ? 'var(--text-2)' : 'var(--text-3)';
  return {
    padding: '.2rem .5rem', fontSize: '.7rem', borderRadius: 999,
    border: '1px solid var(--border)', color, minWidth: 70, textAlign: 'center',
  };
}
