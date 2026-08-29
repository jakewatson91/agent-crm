/**
 * End-to-end check for the add_note tool, driven through the real MCP-over-HTTP
 * endpoint rather than by calling callTool directly — so it exercises the same
 * path Claude Code takes: catalog lookup, JSON Schema, arg validation, dispatch.
 *
 * Asserts the three things that make a note useful:
 *   1. it lands as a fact the drafter can read
 *   2. a DATED note carries happened_at, so it can be the reason we write
 *   3. it becomes a signal, so the enricher pulls structured facts out of it
 *
 * Cleans up after itself. Run: pnpm exec tsx scripts/_chk_add_note.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { pickAnchorCandidates } from '@agent-crm/tools';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const WORKSPACE_NAME = process.env.WORKSPACE_NAME ?? 'Sudden';

async function mcp(workspace_id: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workspace-id': workspace_id,
      'x-actor-kind': 'user',
      'x-actor-id': 'check-add-note',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body.result;
}

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

async function main() {
  const { data: ws } = await sb.from('workspaces').select('id').eq('name', WORKSPACE_NAME).maybeSingle();
  if (!ws) throw new Error(`workspace ${WORKSPACE_NAME} not found`);
  // Entity type lives in an `is_a` fact, not a column — entities.kind was
  // dropped (see packages/tools/src/entity_types.ts).
  const { data: isA } = await sb.from('facts')
    .select('subject_entity')
    .eq('workspace_id', ws.id).eq('predicate', 'is_a').eq('object_text', 'account')
    .is('supersedes', null).limit(1).maybeSingle();
  if (!isA) throw new Error('no account entity to test against');
  const { data: ent } = await sb.from('entities')
    .select('id, name').eq('id', isA.subject_entity).maybeSingle();
  if (!ent) throw new Error('account entity row missing');
  console.log(`workspace ${WORKSPACE_NAME} (${ws.id})\naccount  ${ent.name} (${ent.id})\n`);

  // The catalog must describe the tool, or a client cannot call it.
  const cat = await fetch(`${BASE}/api/mcp`).then((r) => r.json());
  const desc = cat.tools.find((t: { name: string }) => t.name === 'add_note');
  const props = desc?.inputSchema?.properties ? Object.keys(desc.inputSchema.properties) : [];
  console.log('catalog:');
  check('add_note is advertised', Boolean(desc));
  check('its arguments are described', props.length > 0, props.join(', '));
  check('happened_at is discoverable', props.includes('happened_at'));

  const stamp = Date.now();
  const dated = `Their VP Eng said on a call they are re-tendering delivery in Q1 [check ${stamp}]`;
  const undated = `Prefers async email over calls [check ${stamp}]`;
  const happened_at = new Date().toISOString();

  console.log('\ndated note:');
  const r1 = await mcp(ws.id, 'add_note', {
    entity_id: ent.id, note: dated, happened_at, source: 'call with VP Eng',
  });
  check('tool reported success', r1.ok === true, r1.error ?? '');
  check('wrote a fact', Boolean(r1.data?.fact_id));
  check('created a signal for the enricher', Boolean(r1.data?.signal_id));
  check('reports it can anchor outreach', r1.data?.can_anchor_outreach === true);

  const { data: f1 } = await sb.from('facts')
    .select('id, predicate, object_text, happened_at, confidence').eq('id', r1.data.fact_id).maybeSingle();
  check('fact carries happened_at', Boolean(f1?.happened_at), String(f1?.happened_at));
  check('fact kept the source in the text', (f1?.object_text ?? '').includes('call with VP Eng'));
  check('fact is full confidence', Number(f1?.confidence) === 1);

  const { data: sig } = await sb.from('signals')
    .select('id, type, magnitude, structured_tags').eq('id', r1.data.signal_id).maybeSingle();
  check('signal is typed as a note', sig?.type === 'human_note', String(sig?.type));
  check('signal records who wrote it', (sig?.structured_tags as any)?.author_id === 'check-add-note');

  console.log('\nundated note:');
  const r2 = await mcp(ws.id, 'add_note', { entity_id: ent.id, note: undated });
  check('tool reported success', r2.ok === true, r2.error ?? '');
  const { data: f2 } = await sb.from('facts').select('id, happened_at').eq('id', r2.data.fact_id).maybeSingle();
  check('fact has no date', f2?.happened_at === null);
  check('reports it cannot anchor outreach', r2.data?.can_anchor_outreach === false);

  // The point of the date: the anchor picker must accept the dated note and
  // reject the undated one. This is the same function the drafter runs.
  console.log('\nanchor picker (the same one the drafter uses):');
  const picked = pickAnchorCandidates({
    facts: [
      { id: f1!.id, predicate: f1!.predicate, object_text: f1!.object_text, happened_at: f1!.happened_at },
      { id: f2!.id, predicate: 'x', object_text: undated, happened_at: null },
    ],
  });
  check('dated note is an anchor candidate', picked.candidates.some((c) => c.id === f1!.id));
  check('undated note is not', !picked.candidates.some((c) => c.id === f2!.id), JSON.stringify(picked.rejected));

  // Bad input must be refused by the schema, not written.
  console.log('\nvalidation:');
  const bad = await mcp(ws.id, 'add_note', { entity_id: ent.id }).catch(() => null);
  check('a note with no text is rejected', bad === null || bad.ok === false);

  // A note aimed at an entity in a DIFFERENT workspace must not land. Without
  // this the fact would be written against that account and read as native to
  // it, with no sign it came from outside.
  const { data: other } = await sb.from('facts')
    .select('subject_entity, workspace_id')
    .eq('predicate', 'is_a').eq('object_text', 'account')
    .neq('workspace_id', ws.id).is('supersedes', null).limit(1).maybeSingle();
  if (other) {
    const cross = await mcp(ws.id, 'add_note', { entity_id: other.subject_entity, note: 'should never land' });
    check('a note aimed at another workspace is refused',
      cross.ok === false && /not found in this workspace/.test(cross.error ?? ''),
      String(cross.error).slice(0, 60));
    const { count } = await sb.from('facts')
      .select('id', { count: 'exact', head: true })
      .eq('subject_entity', other.subject_entity).eq('object_text', 'should never land');
    check('and nothing was written', (count ?? 0) === 0);
  } else {
    console.log('  SKIP  only one workspace present; cannot test the cross-workspace guard');
  }

  console.log('\ncleanup:');
  const { error: df } = await sb.from('facts').delete().in('id', [r1.data.fact_id, r2.data.fact_id]);
  const ids = [r1.data.signal_id, r2.data.signal_id].filter(Boolean);
  const { error: ds } = await sb.from('signals').delete().in('id', ids);
  check('test rows removed', !df && !ds, `${df?.message ?? ''}${ds?.message ?? ''}`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
