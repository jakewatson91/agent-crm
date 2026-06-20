/**
 * GitHub Events connector.
 *
 * For each watched entity (account), expects a `github_org` alias field. Polls
 * https://api.github.com/orgs/{org}/events and creates signals for high-signal
 * event types: PublicEvent (repo went public), CreateEvent (new repo or branch),
 * ReleaseEvent, MemberEvent (new contributor added), ForkEvent.
 *
 * Auth: optional. Unauthenticated = 60 req/hr; authenticated = 5000 req/hr.
 * If GITHUB_TOKEN env is set, uses it.
 *
 * Config shape:
 *   {
 *     watch_entities: [{ entity_id, name, aliases?, github_org? }],
 *     event_types?: string[],            // default: high-signal subset below
 *     since_hours?: number,              // default 24
 *   }
 *
 * Note: the entity_picker_multi UI already returns { entity_id, name, aliases }.
 * This connector treats the FIRST alias starting with "github:" as the org name,
 * e.g. "github:stripe" -> org=stripe. Falls back to the entity name lowercased.
 */

import { callTool, fetchSeenSignalTags } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }

interface GhEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string; url: string };
  payload: Record<string, unknown>;
  public: boolean;
  created_at: string;
}

const HIGH_SIGNAL_TYPES = ['ReleaseEvent', 'PublicEvent', 'CreateEvent', 'MemberEvent', 'ForkEvent'];

export { githubMeta as meta } from '../registry_meta.js';

function resolveOrg(w: WatchEntity): string {
  const aliasOrg = (w.aliases ?? []).find((a) => a.toLowerCase().startsWith('github:'));
  if (aliasOrg) return aliasOrg.split(':')[1]!.trim();
  return w.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

const github: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  if (!watch.length) { result.errors.push('config.watch_entities is empty'); return result; }
  const event_types = ((ctx.config.event_types as string[]) ?? HIGH_SIGNAL_TYPES);
  const since_hours = (ctx.config.since_hours as number) ?? 24;
  const cutoff = Date.now() - since_hours * 3600 * 1000;
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'agent-crm/github-connector',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Dedup against signals already seen.
  const seenRes = await fetchSeenSignalTags(ctx.supabase, {
    workspace_id: ctx.workspace_id,
    type: 'github_event',
    sinceISO: new Date(cutoff).toISOString(),
  });
  const seenIds = new Set<string>();
  for (const s of seenRes) {
    const id = (s.structured_tags as { gh_event_id?: string } | null)?.gh_event_id;
    if (id) seenIds.add(id);
  }

  for (const w of watch) {
    const org = resolveOrg(w);
    if (!org) { result.errors.push(`could not resolve org for ${w.name}`); continue; }
    let events: GhEvent[];
    try {
      const r = await fetch(`https://api.github.com/orgs/${org}/events?per_page=100`, { headers });
      if (!r.ok) {
        result.errors.push(`gh org=${org} ${r.status}: ${(await r.text()).slice(0, 120)}`);
        continue;
      }
      events = (await r.json()) as GhEvent[];
    } catch (e) {
      result.errors.push(`gh fetch failed for ${org}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    for (const ev of events) {
      if (!event_types.includes(ev.type)) { result.skipped++; continue; }
      const ts = Date.parse(ev.created_at);
      if (Number.isFinite(ts) && ts < cutoff) { result.skipped++; continue; }
      if (seenIds.has(ev.id)) { result.skipped++; continue; }

      const summary = summarizeEvent(ev);
      const r = await callTool(
        ctx.supabase,
        { workspace_id: ctx.workspace_id, actor_kind: 'agent', actor_id: `source:github:${ctx.source_id.slice(0, 8)}` },
        'create_signal',
        {
          entity_id: w.entity_id,
          type: 'github_event',
          magnitude: ev.type === 'ReleaseEvent' ? 0.7 : ev.type === 'PublicEvent' ? 0.65 : 0.45,
          body_for_embedding: summary,
          structured_tags: {
            signal_source: 'github',
            source_id: ctx.source_id,
            gh_event_id: ev.id,
            gh_event_type: ev.type,
            gh_org: org,
            gh_repo: ev.repo.name,
            gh_actor: ev.actor.login,
            matched_alias: w.name,
          },
        },
      );
      if (r.ok) result.signals_created++;
      else result.errors.push(`create_signal failed: ${r.error}`);
    }
  }

  return result;
};

function summarizeEvent(ev: GhEvent): string {
  switch (ev.type) {
    case 'ReleaseEvent': {
      const p = ev.payload as { release?: { name?: string; tag_name?: string; body?: string } };
      return `[GitHub release] ${ev.repo.name} ${p.release?.tag_name ?? ''} ${p.release?.name ?? ''}. ${p.release?.body?.slice(0, 200) ?? ''}`;
    }
    case 'PublicEvent':
      return `[GitHub] ${ev.repo.name} went public.`;
    case 'CreateEvent': {
      const p = ev.payload as { ref_type?: string; ref?: string };
      return `[GitHub] ${ev.repo.name} created ${p.ref_type ?? 'ref'} ${p.ref ?? ''}.`;
    }
    case 'MemberEvent': {
      const p = ev.payload as { member?: { login?: string }; action?: string };
      return `[GitHub] ${ev.repo.name} ${p.action ?? 'updated'} member ${p.member?.login ?? ''}.`;
    }
    case 'ForkEvent':
      return `[GitHub] ${ev.repo.name} was forked by ${ev.actor.login}.`;
    default:
      return `[GitHub ${ev.type}] ${ev.repo.name} by ${ev.actor.login}.`;
  }
}

export default github;
