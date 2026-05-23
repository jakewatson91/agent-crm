/**
 * Day.ai response simulator.
 *
 * Takes the agent-crm projection for an account and constructs Day.ai-shape
 * SearchResultObject responses (per their published SDK at
 * github.com/day-ai/day-ai-sdk, types.ts + SCHEMA.md). The point is to give
 * a Day.ai-flavored agent the same underlying data and see what it costs in
 * tokens.
 *
 * Day.ai's read shape is wider than HubSpot's: 33 properties on Person,
 * ~50 on Organization. workExperience[] and education[] are inlined on Person.
 * Our simulator populates these fields realistically from agent-crm data;
 * fields we don't have (e.g., skills, certifications, gender) stay omitted.
 *
 * Shape control matches the SDK: caller passes propertiesToReturn ('*' or list)
 * and includeRelationships (bool).
 */

import type { Projection } from '../../readers/agent_crm.js';

export type Shape = 'default' | 'tight';

// Day.ai SDK types (mirrored from /tmp/day-ai-sdk/src/types.ts)
export interface SearchResultRelationship {
  objectType: string;
  objectId: string;
  title: string;
  description?: string;
  relationship: string;
}

export interface SearchResultObject {
  objectId: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  properties?: Record<string, unknown>;
  relationships?: SearchResultRelationship[];
}

// Property allowlists for the 'tight' shape — minimum fields a smart Day.ai agent
// dev would request for a drafter/brief/score task.
const TIGHT_ORG_PROPS = new Set(['name', 'domain', 'description', 'industry', 'funding', 'employeeCount', 'news', 'status/currentStatusOneSentence']);
const TIGHT_PERSON_PROPS = new Set(['email', 'firstName', 'lastName', 'currentJobTitle', 'currentCompanyName', 'description']);
const TIGHT_NOTE_PROPS = new Set(['body', 'date']);

function pickProps(props: Record<string, unknown>, allowlist: string[] | '*' | undefined, fallback: Set<string>): Record<string, unknown> {
  if (allowlist === '*' || allowlist === undefined) return props;
  const filter = Array.isArray(allowlist) ? new Set(allowlist) : fallback;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (filter.has(k)) out[k] = v;
  return out;
}

// Map an agent-crm fact onto an Organization property when the predicate matches
// a known Day.ai field. Returns null if the fact doesn't map cleanly (caller
// folds it into description or treats it as a separate Note).
function mapFactToOrgField(predicate: string, object: string | null): { key: string; value: unknown } | null {
  if (!object) return null;
  const p = predicate.toLowerCase();
  if (p === 'funding' || p === 'total_funding' || p === 'last_round') return { key: 'funding', value: object };
  if (p === 'employee_count' || p === 'headcount') return { key: 'employeeCount', value: Number(object) || object };
  if (p === 'industry' || p === 'sector') return { key: 'industry', value: object };
  if (p === 'founded' || p === 'founded_year') return { key: 'founded', value: Number(object) || object };
  if (p === 'annual_recurring_revenue' || p === 'arr' || p === 'annualized_recurring_revenue') return { key: 'annualRevenue', value: object };
  if (p === 'is_hiring' || p === 'hiring') return { key: 'isHiring', value: true };
  if (p === 'mission' || p === 'vision') return { key: 'missionAndVision', value: object };
  if (p === 'description' || p === 'pitch' || p === 'summary') return { key: 'description', value: object };
  return null;
}

export function buildOrganization(projection: Projection, shape: Shape): SearchResultObject {
  const attrs = (projection.account.attributes ?? {}) as Record<string, string>;
  const domain = attrs.domain ?? `${projection.account.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;

  // Realistic Day.ai-style wide Org payload.
  const props: Record<string, unknown> = {
    name: projection.account.name,
    domain,
    description: attrs.description ?? attrs.pitch ?? `${projection.account.name}`,
    aiDescription: `AI-generated summary of ${projection.account.name} (synthetic for benchmark)`,
    founded: 2020,
    industry: 'Software',
    primaryPhoneNumber: '+15555550100',
    employeeCount: 50,
    employeeCountFrom: 25,
    employeeCountTo: 100,
    doesBusinessWith: ['B2B'],
    missionAndVision: `Building the best ${projection.account.name} experience.`,
    values: ['transparency', 'craft', 'speed'],
    differentiators: ['agent-native architecture', 'event-sourced data'],
    isHiring: false,
    industryType: 'Software',
    annualRevenue: 5000000,
    funding: 10000000,
    location: 'San Francisco, CA, USA',
    address: '500 Howard St, San Francisco, CA 94105',
    city: 'San Francisco',
    state: 'CA',
    country: 'USA',
    postalCode: '94105',
    photoSquare: `https://logo.clearbit.com/${domain}`,
    socialTwitter: `https://twitter.com/${projection.account.name.replace(/[^a-z0-9]/gi, '')}`,
    socialLinkedIn: `https://linkedin.com/company/${projection.account.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
    socialFacebook: '',
    socialYouTube: '',
    socialInstagram: '',
    stockTicker: '',
    edgarCik: '',
    crunchbaseEntityId: '',
    linkCrunchbase: `https://crunchbase.com/organization/${projection.account.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
    linkAngelList: '',
    resolvedUrl: `https://${domain}`,
    opportunityIds: [],
    'status/highLevelSummary': [`Engaged with ${projection.account.name}`],
    'status/currentStatusOneSentence': `Active outreach with ${projection.account.name}, last touched recently.`,
    'status/nextSteps': 'Follow up on most recent signal.',
    'status/warmth': 6,
    'objective/relationshipOrigin': 'Outbound email',
    'objective/roles': [],
    hasOpportunity: false,
    traffic: 50000,
    keywords: ['saas', 'ai', 'startup'],
    news: '',
    promises: [],
    naicsCodes: [541511],
    sicCodes: [7372],
  };

  // Overlay matching facts onto known Org fields, fold unmapped fact text into description.
  const unmappedFactLines: string[] = [];
  for (const f of projection.facts) {
    const mapped = mapFactToOrgField(f.predicate, f.object);
    if (mapped) {
      props[mapped.key] = mapped.value;
    } else {
      unmappedFactLines.push(`${f.predicate}: ${f.object ?? '(empty)'}`);
    }
  }
  if (unmappedFactLines.length) {
    props.news = `${props.news || ''}\nAdditional facts:\n - ${unmappedFactLines.join('\n - ')}`.trim();
  }

  const filtered = pickProps(props, shape === 'tight' ? Array.from(TIGHT_ORG_PROPS) : '*', TIGHT_ORG_PROPS);

  // Relationships: contacts (parent->person) + recent notes (parent->context).
  const relationships: SearchResultRelationship[] = [
    ...projection.contacts.map((c) => ({
      objectType: 'native_contact',
      objectId: c.email,
      title: c.name,
      description: c.role,
      relationship: 'employs',
    })),
    ...projection.signals.slice(0, 5).map((s) => ({
      objectType: 'native_context',
      objectId: s.id,
      title: `Signal: ${s.type}`,
      description: s.body.slice(0, 100),
      relationship: 'related',
    })),
  ];
  if (projection.past_touch) {
    relationships.push({
      objectType: 'native_gmailthread',
      objectId: projection.past_touch.id,
      title: `Last touch ~${projection.past_touch.days_ago}d ago`,
      description: projection.past_touch.body.slice(0, 100),
      relationship: 'recipient',
    });
  }

  return {
    objectId: domain,
    title: projection.account.name,
    description: (filtered.description as string | undefined) ?? '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    properties: filtered,
    relationships,
  };
}

export function buildContact(contactId: string, projection: Projection, shape: Shape): SearchResultObject | null {
  const c = projection.contacts.find((x) => x.email === contactId);
  if (!c) return null;
  const [first, ...rest] = c.name.split(' ');
  const last = rest.join(' ') || '';
  const attrs = (projection.account.attributes ?? {}) as Record<string, string>;
  const domain = attrs.domain ?? `${projection.account.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;

  const props: Record<string, unknown> = {
    email: c.email,
    firstName: first ?? '',
    lastName: last,
    linkedInUrl: `https://linkedin.com/in/${(first + '-' + last).toLowerCase()}`,
    description: `${c.role} at ${projection.account.name}`,
    careerSummary: `${first} has spent the last several years in similar roles, most recently as ${c.role} at ${projection.account.name}.`,
    canonicalEmail: c.email,
    primaryPhoneNumber: '+15555550101',
    location: 'San Francisco, CA, USA',
    timezone: 'America/Los_Angeles',
    country: 'USA',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94105',
    headline: `${c.role} at ${projection.account.name}`,
    industry: 'Software',
    socialFacebook: '',
    socialTwitter: `https://twitter.com/${first}`,
    socialGithub: `https://github.com/${first}`,
    socialLinkedIn: `https://linkedin.com/in/${(first + '-' + last).toLowerCase()}`,
    currentCompanyName: projection.account.name,
    currentJobTitle: c.role,
    currentJobStartDate: '2024-01-15',
    skills: ['leadership', 'go-to-market', 'fundraising'],
    languages: ['English'],
    interests: ['SaaS', 'startups', 'AI'],
    workExperience: [
      { companyName: projection.account.name, jobTitle: c.role, startDate: '2024-01-15', endDate: null, description: `Leading ${c.role} efforts.` },
      { companyName: 'Previous Co', jobTitle: 'Director', startDate: '2021-06-01', endDate: '2023-12-31', description: 'Built and scaled the GTM function.' },
    ],
    education: [
      { schoolName: 'Stanford University', degree: 'BA', fieldOfStudy: 'Economics', startDate: '2010-09-01', endDate: '2014-06-15' },
    ],
    certifications: [],
    organization: domain,
    currentWorkEmail: c.email,
    pastEmails: [c.email],
    phoneNumbers: ['+15555550101'],
    photoUrl: `https://gravatar.com/avatar/${c.email}?d=identicon`,
    gender: '',
  };

  const filtered = pickProps(props, shape === 'tight' ? Array.from(TIGHT_PERSON_PROPS) : '*', TIGHT_PERSON_PROPS);

  return {
    objectId: c.email,
    title: c.name,
    description: `${c.role} at ${projection.account.name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    properties: filtered,
    relationships: [
      { objectType: 'native_organization', objectId: domain, title: projection.account.name, relationship: 'works_at' },
    ],
  };
}

// Notes (native_context) bundled — past_touch + each signal + unmapped facts as separate "notes."
export function buildNotes(projection: Projection, shape: Shape): SearchResultObject[] {
  const notes: SearchResultObject[] = [];
  if (projection.past_touch) {
    notes.push({
      objectId: projection.past_touch.id,
      title: `Outbound email ~${projection.past_touch.days_ago}d ago`,
      description: '',
      createdAt: new Date(Date.now() - projection.past_touch.days_ago * 86400_000).toISOString(),
      updatedAt: new Date(Date.now() - projection.past_touch.days_ago * 86400_000).toISOString(),
      properties: shape === 'tight'
        ? { body: projection.past_touch.body, date: new Date(Date.now() - projection.past_touch.days_ago * 86400_000).toISOString() }
        : { body: projection.past_touch.body, date: new Date(Date.now() - projection.past_touch.days_ago * 86400_000).toISOString(), parent_type: 'native_organization', kind: 'gmail_outbound', authorEmail: 'jake@agent-crm.dev' },
    });
  }
  for (const s of projection.signals.slice(0, 5)) {
    notes.push({
      objectId: s.id,
      title: `Signal: ${s.type}`,
      description: '',
      createdAt: s.observed_at,
      updatedAt: s.observed_at,
      properties: shape === 'tight'
        ? { body: s.body, date: s.observed_at }
        : { body: s.body, date: s.observed_at, parent_type: 'native_organization', signal_type: s.type, magnitude: s.magnitude },
    });
  }
  return notes;
}
