/**
 * Per-result verdict dump for the relevance gate. Mirrors the runner exactly
 * (same policy, same clamped angles, same age gate, same grounding, same
 * relevance config) but creates NO signals — it prints every candidate with the
 * test it failed, so a drop can be judged right or wrong by eye.
 *
 * This is the only way to answer "is the gate rejecting wrong-company pages or
 * being too strict", because candidates are never persisted — only accepted
 * ones become signals.
 *
 * SPENDS EXA: ~5 searches per account (~$0.05), plus 1 if grounding is fetched.
 *
 * Usage: tsx scripts/_chk_gate_verdicts.ts "Ab Films TV" "Weyyak"
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveEnvVar, resolveStrategy, runExaSearch, filterResultsByEntity, fetchEntityGrounding } from '@agent-crm/tools';
import { buildAngleRequest } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DESC_RE = /desc|industr|sector|product|offer|what|target|customer|vertical|categor|summary|tagline|business|market|does/;

const TOTAL = { keepHas: 0, keepMissing: 0, dropHas: 0, dropMissing: 0 };

/**
 * Does the company name appear anywhere in the page (title, body, or URL)?
 * Case- and punctuation-insensitive so "ShowMax"/"Showmax" and "AB Films TV"/
 * "abfilmstv" both count. Deliberately loose: this is a junk filter, not a
 * relevance judgement, so any plausible mention passes.
 */
function nameOnPage(name: string, er: { title?: string | null; url: string; text?: string }): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const hay = norm(`${er.title ?? ''} ${er.text ?? ''} ${er.url}`);
  const n = norm(name);
  if (!n) return true;
  return hay.includes(n);
}

async function main() {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!names.length) { console.log('pass account names'); return; }
  const sb = createServerClient();
  const policy = await getPolicy(sb, WS);
  const apiKey = resolveEnvVar(policy, 'EXA_API_KEY');
  if (!apiKey) { console.log('no EXA_API_KEY'); return; }

  const maxAgeDays = policy.research?.max_age_days ?? 30;
  const socialDomains = (policy.research?.social_domains ?? []).filter(Boolean);
  const angles = resolveStrategy(policy);
  const staleCutoffMs = Date.now() - maxAgeDays * 86400 * 1000;

  const wsRow = await sb.from('workspaces').select('icp').eq('id', WS).maybeSingle();
  const st = (wsRow.data?.icp as any)?.signal_type;
  const relevance = {
    pains: ((policy as any).drafter?.pain_points ?? []).filter(Boolean),
    signal_types: Array.isArray(st) ? st.filter((s: unknown) => typeof s === 'string') : [],
  };
  console.log(`policy: max_age_days=${maxAgeDays}  angles=${angles.length}  pains=${relevance.pains.length}  signal_types=${relevance.signal_types.length}`);

  for (const name of names) {
    const { data: ent } = await sb.from('entities').select('id, name, attributes')
      .eq('workspace_id', WS).eq('name', name).maybeSingle();
    if (!ent) { console.log(`\n### ${name}: NOT FOUND`); continue; }
    const e = ent as any;
    const domain = (e.attributes?.domain ?? '').toLowerCase();

    const runnable = angles.filter((a) =>
      (a.domain_scope !== 'own_site' || !!domain) &&
      (a.domain_scope !== 'social' || socialDomains.length > 0));

    const cands: Array<{ angleId: string; scope: string; er: any }> = [];
    const ownSiteSnippets: string[] = [];
    let stale = 0;
    const seen = new Set<string>();
    for (const angle of runnable) {
      const built = buildAngleRequest(angle, e.name, domain, '', socialDomains, undefined, maxAgeDays);
      if (!built) continue;
      const res = await runExaSearch(apiKey, built.params);
      if (!res.ok) { console.log(`  [${angle.id}] EXA ERROR ${res.status ?? ''} ${res.error ?? ''}`); continue; }
      for (const er of res.results) {
        if (!er.id || seen.has(er.id)) continue;
        if (er.publishedDate) {
          const pub = Date.parse(er.publishedDate);
          if (Number.isFinite(pub) && pub < staleCutoffMs) { stale++; continue; }
        }
        seen.add(er.id);
        cands.push({ angleId: angle.id, scope: angle.domain_scope, er });
        if (angle.domain_scope === 'own_site') {
          const snip = [er.title, (er.text ?? '').slice(0, 200)].filter(Boolean).join(' — ');
          if (snip) ownSiteSnippets.push(snip);
        }
      }
    }

    let grounding = ownSiteSnippets.slice(0, 2).join(' | ');
    if (!grounding && domain) grounding = await fetchEntityGrounding(apiKey, e.name, domain);
    const { data: fdata } = await sb.from('facts').select('predicate, object_text')
      .eq('workspace_id', WS).eq('subject_entity', e.id).is('supersedes', null).limit(40);
    const desc: string[] = [];
    for (const f of (fdata ?? []) as Array<{ predicate: string; object_text: string | null }>) {
      if (/^score_/.test(f.predicate) || /_breakdown$/.test(f.predicate)) continue;
      if (!DESC_RE.test(f.predicate)) continue;
      const v = f.object_text?.trim();
      if (!v || v.length < 3) continue;
      desc.push(`${f.predicate}: ${v}`);
      if (desc.length >= 6) break;
    }
    const context = [grounding, desc.join('; ')].filter(Boolean).join(' || ').slice(0, 600);

    console.log(`\n########## ${e.name}  [${domain}] ##########`);
    console.log(`candidates ${cands.length}, stale-dropped ${stale}, context ${context.length} chars (hasContext=${context.trim().length >= 40})`);
    if (!cands.length) continue;

    const rel = await filterResultsByEntity(
      { name: e.name, domain, context, relevance },
      cands.map((c) => ({ id: c.er.id, title: c.er.title, url: c.er.url, text: c.er.text })),
    );
    console.log(`accepted ${rel.accepted.size}/${cands.length} (auto-own-domain ${rel.auto})  drops: ${JSON.stringify(rel.droppedBy)}\n`);
    // Agreement between a free local check (is the company name anywhere in the
    // title/text/url?) and the paid LLM verdict. If nothing the LLM keeps is
    // missing the name, the local check can run first and the LLM never sees the
    // junk. `nameMissing && accepted` is the only cell that would cost a signal.
    let m = { keepHas: 0, keepMissing: 0, dropHas: 0, dropMissing: 0 };
    for (const c of cands) {
      const ok = rel.accepted.has(c.er.id);
      const has = nameOnPage(e.name, c.er);
      if (ok && has) m.keepHas++; else if (ok && !has) m.keepMissing++;
      else if (!ok && has) m.dropHas++; else m.dropMissing++;
      const why = ok ? (rel.classById.get(c.er.id) ?? 'auto') : (rel.rejectReasonById.get(c.er.id) ?? '?');
      const date = c.er.publishedDate ? c.er.publishedDate.slice(0, 10) : 'undated';
      console.log(`${ok ? '  KEEP' : '  DROP'} [${why.padEnd(9)}] name=${has ? 'yes' : 'NO '} ${date} (${c.angleId})`);
      console.log(`        ${(c.er.title ?? '(no title)').slice(0, 100)}`);
      console.log(`        ${c.er.url}`);
    }
    console.log(`\n  local-name-check vs LLM: kept+name ${m.keepHas} | kept-but-NO-name ${m.keepMissing} (these would be lost) | dropped+name ${m.dropHas} | dropped+no-name ${m.dropMissing} (free to kill)`);
    TOTAL.keepHas += m.keepHas; TOTAL.keepMissing += m.keepMissing;
    TOTAL.dropHas += m.dropHas; TOTAL.dropMissing += m.dropMissing;
  }
  const t = TOTAL;
  console.log(`\n======== across all accounts ========`);
  console.log(`kept by LLM, name present : ${t.keepHas}`);
  console.log(`kept by LLM, name ABSENT  : ${t.keepMissing}   <- signals a local pre-filter would cost`);
  console.log(`dropped by LLM, name present: ${t.dropHas}   <- still needs the LLM`);
  console.log(`dropped by LLM, name absent : ${t.dropMissing}   <- killable for free, never reaches the LLM`);
  const tot = t.keepHas + t.keepMissing + t.dropHas + t.dropMissing;
  if (tot) console.log(`local pre-filter would remove ${((t.dropMissing + t.keepMissing) / tot * 100).toFixed(0)}% of candidates before any LLM call`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
