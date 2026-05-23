import { config } from 'dotenv';
config({ path: '.env.local' });
import { readProjection } from './readers/agent_crm.js';
import { execTool } from './readers/hubspot.js';

async function main() {
  console.log('=== agent-crm projection for 11x.ai ===');
  const p = await readProjection('11x.ai');
  console.log(`api_calls: ${p.api_calls}, latency: ${p.latency_ms}ms`);
  console.log(`facts: ${p.projection.facts.length}, contacts: ${p.projection.contacts.length}, signals: ${p.projection.signals.length}, past_touch_id: ${p.projection.past_touch?.id ?? 'NONE'}`);

  console.log('\n=== HubSpot tool: get company 11x.ai ===');
  const co = await execTool('hubspot_get_company_by_name', { name: '11x.ai' });
  const body = co.response.body as { results?: Array<{ id?: string }> };
  const compId = body?.results?.[0]?.id;
  console.log(`status: ${co.response.status}, company_id: ${compId}, latency: ${co.latency_ms}ms`);

  if (compId) {
    console.log('\n=== HubSpot tool: get associated contacts ===');
    const contacts = await execTool('hubspot_get_associated_contacts', { company_id: compId });
    const cbody = contacts.response.body as { results?: unknown[] };
    console.log(`status: ${contacts.response.status}, contacts count: ${cbody?.results?.length ?? 0}, latency: ${contacts.latency_ms}ms`);

    console.log('\n=== HubSpot tool: get notes ===');
    const notes = await execTool('hubspot_get_recent_notes', { company_id: compId });
    const nbody = notes.response.body as { results?: unknown[] };
    console.log(`status: ${notes.response.status}, notes count: ${nbody?.results?.length ?? 0}, latency: ${notes.latency_ms}ms`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
