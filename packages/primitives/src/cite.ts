import type { SupabaseClient } from '@supabase/supabase-js';
import { CiteArgsSchema, type Cite, type FactRow } from './types.js';

/**
 * Walk the provenance chain for a fact (or any claim id that resolves to a fact).
 * Returns the fact plus the chain back through supersede links and the source events.
 */
export async function cite(
  supabase: SupabaseClient,
  args: { id: string },
): Promise<{ fact: FactRow; chain: Cite[] }> {
  const v = CiteArgsSchema.parse(args);

  const { data: fact, error } = await supabase.from('facts').select('*').eq('id', v.id).maybeSingle();
  if (error) throw error;
  if (!fact) throw new Error(`No fact with id ${v.id}`);

  // Walk supersede chain backwards.
  const chain: Cite[] = [];
  let cursor: FactRow | null = fact as FactRow;
  while (cursor) {
    const { data: ev } = await supabase
      .from('events')
      .select('id,prompt_hash')
      .eq('id', cursor.source_event_id)
      .maybeSingle();
    chain.push({
      fact_id: cursor.id,
      source_event_id: cursor.source_event_id,
      prompt_hash: ev?.prompt_hash ?? null,
    });
    if (!cursor.supersedes) break;
    const prev: { data: FactRow | null } = await supabase
      .from('facts')
      .select('*')
      .eq('id', cursor.supersedes)
      .maybeSingle();
    cursor = prev.data;
  }

  return { fact: fact as FactRow, chain };
}
