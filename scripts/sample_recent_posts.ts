/**
 * Show 3 recent posts of each kind so we can audit quality.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  for (const kind of ['decision', 'touch_draft', 'claim', 'gate_request']) {
    const r = await sb.from('channel_posts')
      .select('body, kind, author_id, created_at, channels:channel_id(title)')
      .eq('kind', kind)
      .order('created_at', { ascending: false })
      .limit(3);
    console.log(`\n=== ${kind.toUpperCase()} (3 most recent) ===`);
    for (const p of (r.data ?? []) as Array<any>) {
      const channel = p.channels?.title ?? '?';
      console.log(`\n  [${(p.created_at as string).slice(5, 16)}] ${channel} · ${p.author_id}`);
      console.log((p.body as string).split('\n').map((l: string) => `    ${l}`).join('\n').slice(0, 600));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
