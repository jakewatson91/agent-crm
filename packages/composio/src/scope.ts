/**
 * Read vs write classification for Composio actions.
 *
 * Reads run free (subject to the workspace's policy). Writes go through the
 * existing gate flow when the workspace policy says so. Dangerous actions
 * (delete, send, post) always require gate approval regardless of policy.
 */
export type ToolScope = 'read' | 'write' | 'dangerous';

/**
 * Classify an action slug by name patterns.
 *
 * Defaults to 'write' on ambiguity so we never auto-execute something we
 * haven't reasoned about. Curated catalogs override this per-slug.
 */
export function classifyUnknown(slug: string): ToolScope {
  const s = slug.toUpperCase();
  // Dangerous: anything that fans out externally or destroys data.
  if (/_SEND($|_)|_POST($|_)|_DELETE($|_)|_CREATE_DRAFT|_PUBLISH/.test(s)) return 'dangerous';
  // Read-shaped verbs.
  if (/_GET($|_)|_LIST($|_)|_SEARCH($|_)|_FETCH($|_)|_READ($|_)|_FIND($|_)|_COUNT($|_)/.test(s)) {
    return 'read';
  }
  return 'write';
}
