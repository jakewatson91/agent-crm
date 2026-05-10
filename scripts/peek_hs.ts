import { config } from 'dotenv';
config({ path: '.env.local' });
const HS = process.env.HUBSPOT_SERVICE_KEY!;
async function main() {
const r = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HS}` },
  body: JSON.stringify({
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: 'Resona Labs' }] }],
    properties: ['name','domain','description','stack','agent_facts','agent_signals','createdate','hs_lastmodifieddate','lifecyclestage','hs_object_id'],
    limit: 1,
  }),
});
const j = await r.json() as { results: any[] };
console.log('=== full envelope ===');
console.log(JSON.stringify(j.results[0], null, 2));
const minified = JSON.stringify(j.results[0]);
console.log('\nminified size: ' + minified.length + ' chars (~' + Math.round(minified.length / 4) + ' tokens by 4-char approx)');

// Now compare what a tightened envelope (only our custom properties + name + description) would be
const tight: any = {
  id: j.results[0].id,
  properties: {
    name: j.results[0].properties.name,
    domain: j.results[0].properties.domain,
    description: j.results[0].properties.description,
    stack: j.results[0].properties.stack,
    agent_facts: j.results[0].properties.agent_facts,
    agent_signals: j.results[0].properties.agent_signals,
  },
};
const tightStr = JSON.stringify(tight);
console.log('\nminified TIGHT size: ' + tightStr.length + ' chars (~' + Math.round(tightStr.length / 4) + ' tokens)');
console.log('savings from removing system fields: ' + (minified.length - tightStr.length) + ' chars (~' + Math.round((minified.length - tightStr.length) / 4) + ' tokens)');
}
main();
