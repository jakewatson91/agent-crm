/**
 * What can an outside agent (Claude Code, Cowork) actually do against this CRM?
 *
 * Drives the real MCP-over-HTTP endpoint the same way an MCP client does, and
 * checks the two things that decide whether the harness is usable:
 *
 *   1. every tool describes its own arguments — a client that has to guess
 *      field names cannot call anything reliably
 *   2. the read-only "what should I do next" verbs work end to end
 *
 * Read-only by default. Set PULL_CONTACTS_ENTITY=<uuid> to also exercise
 * pull_contacts, which spends contact-provider credit.
 *
 * Run: pnpm exec tsx scripts/_chk_agent_surface.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const WORKSPACE_NAME = process.env.WORKSPACE_NAME ?? 'Sudden';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

async function rpc(workspace_id: string, method: string, params: unknown) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workspace-id': workspace_id,
      'x-actor-kind': 'user',
      'x-actor-id': 'chk-agent-surface',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (!text) throw new Error(`empty body (HTTP ${res.status}) — dev server may still be compiling; rerun`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function main() {
  const { data: ws } = await sb.from('workspaces').select('id').eq('name', WORKSPACE_NAME).maybeSingle();
  if (!ws) throw new Error(`workspace ${WORKSPACE_NAME} not found`);
  console.log(`workspace ${WORKSPACE_NAME} (${ws.id})\nendpoint  ${BASE}/api/mcp\n`);

  console.log('tool catalog — can a client call these without guessing?');
  const { tools } = await rpc(ws.id, 'tools/list', {});
  const schemaless = tools.filter((t: any) => {
    const p = t.inputSchema?.properties;
    // A tool that genuinely takes no arguments is complete, not schemaless.
    return !p || (Object.keys(p).length === 0 && t.inputSchema?.additionalProperties !== false);
  });
  check(`${tools.length} tools advertised`, tools.length > 0);
  check('every tool describes its arguments', schemaless.length === 0,
    schemaless.length ? schemaless.map((t: any) => t.name).join(', ') : '');
  const withRequired = tools.filter((t: any) => Array.isArray(t.inputSchema?.required) && t.inputSchema.required.length);
  check('required fields are marked', withRequired.length > 0, `${withRequired.length} tools declare required args`);
  const withEnum = tools.filter((t: any) => JSON.stringify(t.inputSchema ?? {}).includes('"enum"'));
  check('enums are published', withEnum.length > 0, `${withEnum.length} tools publish allowed values`);

  console.log('\nlist_approvals — "what needs me today"');
  const la = await rpc(ws.id, 'tools/call', { name: 'list_approvals', arguments: { limit: 5 } });
  check('returned ok', la.ok === true, la.error ?? '');
  check('reports a pending count', typeof la.data?.pending === 'number', `pending=${la.data?.pending}`);
  check('rows carry a gate_id for decide_gate',
    la.data.approvals.every((a: any) => typeof a.gate_id === 'string'));
  check('rows say how long they have waited',
    la.data.approvals.every((a: any) => typeof a.waiting_days === 'number'),
    la.data.approvals.length ? `oldest ${la.data.oldest_waiting_days}d` : 'queue empty');
  // The count must be the TRUE number waiting, not the size of this page — an
  // agent told "5 pending" against a queue of 28 would stop after five.
  const { count } = await sb.from('gates')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws.id).is('decided_at', null);
  check('pending is the true total, not the page size',
    (count ?? 0) === la.data.pending, `db=${count} tool=${la.data.pending}`);
  check('the page size is reported separately',
    la.data.returned === la.data.approvals.length,
    `returned=${la.data.returned} of ${la.data.pending}`);

  console.log('\nfilter by kind');
  const filtered = await rpc(ws.id, 'tools/call', { name: 'list_approvals', arguments: { limit: 5, policy: 'outreach_send' } });
  check('policy filter applies', filtered.ok === true
    && filtered.data.approvals.every((a: any) => a.policy === 'outreach_send'),
    `${filtered.data.pending} outreach_send waiting`);

  console.log('\nvalidation is enforced, not advisory');
  const bad = await rpc(ws.id, 'tools/call', { name: 'list_approvals', arguments: { limit: 9999 } }).catch(() => null);
  check('an out-of-range limit is rejected', bad === null || bad.ok === false,
    bad?.error ? String(bad.error).slice(0, 60) : '');

  console.log('\nresearch_account — refusals must be specific, never a queued dead run');
  // An entity with no resolved domain has nothing to search, so the tool must
  // say that rather than spend a search finding out.
  const { data: domainless } = await sb.from('entities')
    .select('id, name, attributes').eq('workspace_id', ws.id).limit(200);
  const noDomain = (domainless ?? []).find((e: any) => !e.attributes?.domain);
  if (noDomain) {
    const r = await rpc(ws.id, 'tools/call', { name: 'research_account', arguments: { entity_id: noDomain.id } });
    check('an account with no domain is refused, with the reason',
      r.ok === false && /domain/i.test(r.error ?? ''), String(r.error).slice(0, 80));
  } else {
    console.log('  SKIP  no domainless account in this workspace to test the refusal');
  }
  const missing = await rpc(ws.id, 'tools/call', {
    name: 'research_account', arguments: { entity_id: '00000000-0000-0000-0000-000000000000' },
  });
  check('an unknown entity is refused', missing.ok === false, String(missing.error).slice(0, 60));
  const overBudget = await rpc(ws.id, 'tools/call', {
    name: 'research_account', arguments: { entity_id: '00000000-0000-0000-0000-000000000000', angle_count: 99 },
  });
  check('an absurd angle_count is rejected by the schema',
    overBudget.ok === false && /Invalid args/.test(String(overBudget.error)));

  if (process.env.RESEARCH_ENTITY) {
    console.log('\nresearch_account — real dispatch (spends search credit)');
    const rr = await rpc(ws.id, 'tools/call', { name: 'research_account', arguments: { entity_id: process.env.RESEARCH_ENTITY, angle_count: 1, reason: 'agent-surface check' } });
    check('queued', rr.ok === true, JSON.stringify(rr.data ?? rr.error).slice(0, 120));
  } else {
    console.log('\nresearch_account — real dispatch skipped (set RESEARCH_ENTITY=<uuid>; it costs search credit)');
  }

  const pullTarget = process.env.PULL_CONTACTS_ENTITY;
  if (pullTarget) {
    console.log('\npull_contacts (spends provider credit)');
    const pc = await rpc(ws.id, 'tools/call', { name: 'pull_contacts', arguments: { entity_id: pullTarget } });
    check('returned ok', pc.ok === true, JSON.stringify(pc.data));
    check('reports found and created', typeof pc.data?.found === 'number' && typeof pc.data?.created === 'number');
  } else {
    console.log('\npull_contacts — skipped (set PULL_CONTACTS_ENTITY=<uuid> to exercise it; it costs credit)');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
