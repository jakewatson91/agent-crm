import { createServerClient } from '@agent-crm/db';
import { EntityDetail } from './EntityDetail';

export const dynamic = 'force-dynamic';

export default async function EntityPage({
  params,
}: {
  params: Promise<{ ws: string; entity_id: string }>;
}) {
  const { ws, entity_id } = await params;
  const supabase = createServerClient();

  // The channel lookup doesn't depend on the other two reads, so all three go
  // in one round; its result is only used when the entity turns out to be an
  // account (account channels aggregate posts/touches/gates).
  const [entityRes, typesRes, chRes] = await Promise.all([
    supabase
      .from('entities')
      .select('id, name, attributes')
      .eq('workspace_id', ws)
      .eq('id', entity_id)
      .maybeSingle(),
    supabase
      .from('facts')
      .select('object_text')
      .eq('workspace_id', ws)
      .eq('subject_entity', entity_id)
      .eq('predicate', 'is_a')
      .is('supersedes', null),
    supabase
      .from('channels')
      .select('id')
      .eq('workspace_id', ws)
      .eq('account_entity_id', entity_id)
      .maybeSingle(),
  ]);
  const entity = entityRes.data;

  if (!entity) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>not found</h2>
        <div className="subtle" style={{ fontSize: '.85rem' }}>
          No entity with id {entity_id} in this workspace.
        </div>
      </section>
    );
  }

  const types = ((typesRes.data ?? []) as Array<{ object_text: string | null }>)
    .map((r) => r.object_text)
    .filter((s): s is string => !!s);
  const primaryType = types[0] ?? 'entity';

  const channelId = types.includes('account') ? (chRes.data?.id ?? null) : null;

  return (
    <EntityDetail
      ws={ws}
      entityId={entity_id}
      entityName={entity.name}
      entityKind={primaryType}
      entityAttributes={(entity.attributes ?? {}) as Record<string, unknown>}
      channelId={channelId}
    />
  );
}
