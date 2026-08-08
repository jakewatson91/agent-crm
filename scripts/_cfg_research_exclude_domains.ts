/**
 * Set policy.research.exclude_domains: hosts the name-searched research angles
 * (news, open_web) must never return.
 *
 * For repost aggregators. A site that republishes someone else's article under
 * its own timestamp defeats every date check downstream, because the date on
 * the page really is the date that copy was posted. Keeping the host out of the
 * search is the only place the problem can be caught.
 *
 * Hosts come from the command line, never from this file. Which sites are junk
 * depends on what the workspace sells and where its buyers publish.
 *
 *   tsx scripts/_cfg_research_exclude_domains.ts                    # show current
 *   tsx scripts/_cfg_research_exclude_domains.ts us.ok.com          # set
 *   tsx scripts/_cfg_research_exclude_domains.ts --add spam.example # append
 *   tsx scripts/_cfg_research_exclude_domains.ts --clear            # remove all
 *
 * Workspace via BACKFILL_WORKSPACE_ID, defaulting to Sudden.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const WS = process.env.BACKFILL_WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

/** Reduce whatever the operator typed to a bare host: a pasted URL works too. */
function toHost(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const withScheme = /^https?:\/\//.test(s) ? s : `https://${s}`;
  try { return new URL(withScheme).hostname.replace(/^www\./, '') || null; } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const add = args.includes('--add');
  const clear = args.includes('--clear');
  const hosts = args.filter((a) => !a.startsWith('--')).map(toHost).filter((h): h is string => !!h);

  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const research = (policy.research as Record<string, unknown>) ?? {};
  const current = ((research.exclude_domains as string[]) ?? []).filter(Boolean);

  console.log(`workspace ${WS}`);
  console.log(`current exclude_domains: ${current.length ? current.join(', ') : '(none)'}`);

  if (!clear && !hosts.length) {
    console.log('\nNothing to change. Pass one or more hosts to set, --add to append, --clear to empty.');
    return;
  }

  const next = clear ? [] : [...new Set(add ? [...current, ...hosts] : hosts)].sort();
  const { error: upErr } = await sb.from('workspaces')
    .update({ policy: { ...policy, research: { ...research, exclude_domains: next } } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log(`new exclude_domains:     ${next.length ? next.join(', ') : '(none)'}`);
  console.log('\nTakes effect on the next research run. Signals already ingested are unaffected.');
}
main().catch((e) => { console.error(e); process.exit(1); });
