import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Batch-resolve entity ids → display names. Used wherever a fact references
 * another entity (facts.object_entity) so the UI can render a link with the
 * entity's name instead of a bare UUID. RLS scopes the select.
 */
export async function resolveEntityNames(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return out;
  const { data } = await supabase.from('entities').select('id, name').in('id', uniq);
  for (const e of (data ?? []) as Array<{ id: string; name: string }>) {
    out.set(e.id, e.name);
  }
  return out;
}
