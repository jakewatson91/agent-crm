import type { Connector, ConnectorMeta } from './types.js';
import apiCall, { meta as apiCallMeta } from './connectors/api_call.js';
import exa, { meta as exaMeta } from './connectors/exa.js';
import web, { meta as webMeta } from './connectors/web.js';
import hn, { meta as hnMeta } from './connectors/hn.js';
import yc, { meta as ycMeta } from './connectors/yc.js';
import github, { meta as githubMeta } from './connectors/github.js';
import githubTrending, { meta as githubTrendingMeta } from './connectors/github_trending.js';
import producthunt, { meta as phMeta } from './connectors/producthunt.js';

export type { Connector, ConnectorMeta, ConnectorContext, ConnectorResult } from './types.js';

/**
 * Registry of source connectors.
 *
 * Two categories (set on each meta):
 *   - 'tool':   generic capability (api_call, exa, web). User fills config from scratch.
 *   - 'preset': hardcoded source (hn, yc, github, producthunt). One-click setup.
 *
 * Adding a new SOURCE shouldn't require a new tool. Most should be implementable as a
 * preset that uses an existing tool's config shape — eventually presets become rows in
 * a table, not code. For now, presets are tool-internal (HN's connector hardcodes the
 * Algolia URL, etc.) but the category split makes the migration path obvious.
 */
export const CONNECTORS: Record<string, { run: Connector; meta: ConnectorMeta }> = {
  api_call: { run: apiCall, meta: apiCallMeta },
  exa: { run: exa, meta: exaMeta },
  web: { run: web, meta: webMeta },
  hn: { run: hn, meta: hnMeta },
  yc: { run: yc, meta: ycMeta },
  github: { run: github, meta: githubMeta },
  github_trending: { run: githubTrending, meta: githubTrendingMeta },
  producthunt: { run: producthunt, meta: phMeta },
};

export function listConnectors(): ConnectorMeta[] {
  return Object.values(CONNECTORS).map((c) => c.meta);
}

export function getConnector(type: string) {
  return CONNECTORS[type];
}
