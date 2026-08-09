/**
 * What has the `social` scope actually bought? Counts signals and facts back to
 * every social-scoped angle the workspace has ever run, so removing it is an
 * evidence call rather than an impression.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 45);

async function fetchAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0; const pg = 1000;
  for (;;) { const { data, error } = await build(f, f + pg - 1); if (error) throw error; if (!data?.length) break; out = out.concat(data); if (data.length < pg) break; f += pg; }
  return out;
}

(async () => {
  const policy = await getPolicy(sb as any, WS);
  const socialDomains = policy.research?.social_domains ?? [];
  console.log(`policy.research.social_domains = ${JSON.stringify(socialDomains)}`);

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  // Searches spent per angle, off the run markers.
  const ev = ((await sb.from('events').select('payload').eq('workspace_id', WS)
    .eq('action', 'research_completed').gte('created_at', since).limit(3000)).data ?? []) as any[];
  let runs = 0, searches = 0;
  const keptPerAngle: Record<string, number> = {};
  for (const e of ev) {
    const d = e.payload ?? {};
    runs++; searches += d.searches ?? 0;
    for (const [k, v] of Object.entries(d.per_angle ?? {})) keptPerAngle[k] = (keptPerAngle[k] ?? 0) + (v as number);
  }

  // Signals per angle, and the facts traceable to them.
  const sigs = await fetchAll<any>((f, t) => sb.from('signals').select('id, structured_tags')
    .eq('workspace_id', WS).eq('type', 'research_result').gte('observed_at', since).range(f, t));
  const byAngle = new Map<string, { sigs: number; ids: string[]; hosts: Map<string, number> }>();
  for (const s of sigs) {
    const a = s.structured_tags?.research_angle ?? '(none)';
    if (!byAngle.has(a)) byAngle.set(a, { sigs: 0, ids: [], hosts: new Map() });
    const b = byAngle.get(a)!;
    b.sigs++; b.ids.push(s.id);
    let h = '?'; try { h = new URL(s.structured_tags?.url ?? '').hostname.replace(/^www\./, ''); } catch { /* */ }
    b.hosts.set(h, (b.hosts.get(h) ?? 0) + 1);
  }
  const factCount = new Map<string, number>();
  for (const [a, b] of byAngle) {
    let n = 0;
    for (let i = 0; i < b.ids.length; i += 200) {
      const r = await sb.from('facts').select('id', { count: 'exact', head: true }).in('signal_id', b.ids.slice(i, i + 200));
      n += r.count ?? 0;
    }
    factCount.set(a, n);
  }

  console.log(`\nlast ${DAYS}d: ${runs} runs, ${searches} searches\n`);
  console.log('angle                     signals  facts  top hosts');
  for (const [a, b] of [...byAngle.entries()].sort((x, y) => y[1].sigs - x[1].sigs)) {
    const hosts = [...b.hosts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([h, c]) => `${h}(${c})`).join(' ');
    console.log(`  ${a.padEnd(24)} ${String(b.sigs).padStart(6)} ${String(factCount.get(a) ?? 0).padStart(6)}  ${hosts}`);
  }

  // Anything served from a configured social host, whatever angle fetched it.
  if (socialDomains.length) {
    const onSocial = sigs.filter((s) => socialDomains.some((d) => String(s.structured_tags?.url ?? '').includes(d)));
    const profiles = onSocial.filter((s) => /\/in\/|\/profile\//i.test(String(s.structured_tags?.url ?? '')));
    let socialFacts = 0;
    const ids = onSocial.map((s) => s.id);
    for (let i = 0; i < ids.length; i += 200) {
      const r = await sb.from('facts').select('id', { count: 'exact', head: true }).in('signal_id', ids.slice(i, i + 200));
      socialFacts += r.count ?? 0;
    }
    console.log(`\nsignals served from a configured social host: ${onSocial.length}`);
    console.log(`  of those, bare profile URLs (/in/ or /profile/): ${profiles.length}`);
    console.log(`  facts extracted from ALL social-host signals:    ${socialFacts}`);
  }
})();
