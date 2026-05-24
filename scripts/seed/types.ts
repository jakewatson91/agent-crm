/**
 * Shape of a demo-workspace seed profile.
 *
 * Profiles are vertical-specific content (KB entries, source lists, workspace
 * name match pattern). They live in their own module so the seeder script
 * stays vertical-neutral.
 */

export interface SeedRssSource {
  name: string;
  url: string;
  description: string;
  keywords: string[];
}

export interface SeedExaSource {
  name: string;
  query: string;
  keywords: string[];
  include_domains: string[];
}

export interface SeedProfile {
  /** ILIKE pattern used to locate the target workspace by name. */
  workspace_name_pattern: string;
  knowledge_base: string;
  rss_sources: SeedRssSource[];
  exa_sources: SeedExaSource[];
}
