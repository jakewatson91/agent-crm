/**
 * One-shot: copy legacy named secret fields on workspaces.policy into the
 * generic policy.env bag. Idempotent — only sets a key when missing in env.
 * Legacy fields are NOT removed; readers still fall back to them for one
 * release. A follow-up sprint deletes the legacy fields.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const LEGACY_TO_ENV: Array<{ path: (p: any) => string | undefined; env_name: string }> = [
  { path: (p) => p?.llm?.openai_api_key,        env_name: 'OPENAI_API_KEY' },
  { path: (p) => p?.llm?.openrouter_api_key,    env_name: 'OPENROUTER_API_KEY' },
  { path: (p) => p?.llm?.default_chat_model,    env_name: 'DEFAULT_CHAT_MODEL' },
  { path: (p) => p?.llm?.drafter_model,         env_name: 'DRAFTER_MODEL' },
  { path: (p) => p?.outreach?.resend_api_key,   env_name: 'RESEND_API_KEY' },
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const r = await sb.from('workspaces').select('id, name, policy');
  if (r.error) { console.error(r.error.message); process.exit(1); }
  const workspaces = (r.data ?? []) as Array<{ id: string; name: string; policy: any }>;
  console.log(`scanning ${workspaces.length} workspace(s)...\n`);

  let updated = 0;
  for (const ws of workspaces) {
    const policy = ws.policy ?? {};
    const env = { ...(policy.env ?? {}) } as Record<string, string>;
    const added: string[] = [];
    for (const m of LEGACY_TO_ENV) {
      const v = m.path(policy);
      if (typeof v === 'string' && v.length && !env[m.env_name]) {
        env[m.env_name] = v;
        added.push(m.env_name);
      }
    }
    if (added.length === 0) {
      console.log(`[skip] ${ws.name} — env already complete or no legacy values`);
      continue;
    }
    const newPolicy = { ...policy, env };
    const upd = await sb.from('workspaces').update({ policy: newPolicy }).eq('id', ws.id);
    if (upd.error) { console.log(`[err]  ${ws.name} — ${upd.error.message}`); continue; }
    console.log(`[ok]   ${ws.name} — added: ${added.join(', ')}`);
    updated += 1;
  }
  console.log(`\ndone. updated=${updated}/${workspaces.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
