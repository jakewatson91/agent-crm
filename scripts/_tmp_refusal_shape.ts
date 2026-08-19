/**
 * Date-buckets the drafter's refusals on Sudden and splits them into
 * "the recipient's job title did not match a template audience" vs everything
 * else. The point is to find out whether the recipient-shaped refusals stopped
 * when the four templates were switched off (enabled:false, 2026-08-14), since
 * the audience rule only renders when at least one template is enabled
 * (prompt_builders.ts:338 filters, :435 is the rule).
 *
 * Scratch. Safe to delete.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 40);

// Words that only appear when the refusal is about WHO we found, not what we know.
const ROLE_RE = /template|audience|recipient|job title|persona|CTO|VP Engineering|technical owner|founder|CEO|Head of|Director of|decision.?maker|contact is a|only contacts are/i;

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();

  const chans = await sb.from('channels').select('id, account_entity_id').eq('workspace_id', WS);
  const chIds = (chans.data ?? []).map((c) => c.id as string);
  const acctOf = new Map<string, string>((chans.data ?? []).map((c) => [c.id as string, c.account_entity_id as string]));

  const rows: Array<{ created_at: string; body: string; channel_id: string }> = [];
  for (let i = 0; i < chIds.length; i += 100) {
    const { data, error } = await sb.from('channel_posts')
      .select('created_at, body, channel_id')
      .in('channel_id', chIds.slice(i, i + 100))
      .eq('kind', 'decision')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw error;
    for (const r of data ?? []) if (String(r.body ?? '').includes('facts_insufficient_for_draft')) rows.push(r as never);
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const byDay = new Map<string, { role: number; other: number }>();
  let role = 0;
  for (const r of rows) {
    const isRole = ROLE_RE.test(r.body);
    if (isRole) role++;
    const d = r.created_at.slice(0, 10);
    const b = byDay.get(d) ?? { role: 0, other: 0 };
    b[isRole ? 'role' : 'other']++;
    byDay.set(d, b);
  }

  console.log(`refusals (facts_insufficient_for_draft) on Sudden, last ${DAYS}d: ${rows.length}`);
  console.log(`  recipient-shaped: ${role}   fact-shaped: ${rows.length - role}\n`);
  console.log('day          recipient  other');
  for (const [d, b] of [...byDay].sort()) console.log(`${d}   ${String(b.role).padStart(6)} ${String(b.other).padStart(6)}`);

  console.log('\n--- every refusal since 2026-08-14 (the day templates went off) ---');
  const names = new Map<string, string>();
  const acctIds = [...new Set(rows.map((r) => acctOf.get(r.channel_id)).filter(Boolean) as string[])];
  for (let i = 0; i < acctIds.length; i += 100) {
    const { data } = await sb.from('entities').select('id, name').in('id', acctIds.slice(i, i + 100));
    for (const e of data ?? []) names.set(e.id as string, e.name as string);
  }
  for (const r of rows.filter((r) => r.created_at >= '2026-08-14')) {
    const nm = names.get(acctOf.get(r.channel_id) ?? '') ?? '?';
    console.log(`\n${r.created_at.slice(0, 16)}  ${nm}${ROLE_RE.test(r.body) ? '  [RECIPIENT]' : ''}\n  ${r.body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
