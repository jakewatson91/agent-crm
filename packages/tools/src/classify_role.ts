/**
 * Role-family classifier. Maps a job title (+ optional department) to a
 * structured {family, seniority, is_exec} object so the ATS connector can
 * decide whether a posting matches the workspace's hiring_filter.
 *
 * Vertical-neutral: the families/seniorities are a fixed taxonomy. The
 * workspace's hiring_filter picks which families/seniorities count for
 * ITS buyer. No vertical-specific defaults live here.
 *
 * Cached deploy-wide by SHA-256 of lower(title)+'|'+lower(department||'') in
 * the `role_classifications` table. Same title across all workspaces → one
 * LLM call ever. Typical ATS run hits cache for ~95%+ of titles after the
 * first day.
 *
 * Not a new "agent" — a deterministic enrichment tool. Single LLM call,
 * strict JSON, no critic/judge/scorer behavior.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace } from './chat_workspace.ts';

export const ROLE_FAMILIES = [
  'sales',
  'gtm',
  'revops',
  'growth',
  'customer_success',
  'marketing',
  'engineering',
  'product',
  'design',
  'data',
  'ml_ai',
  'ops',
  'finance',
  'people',
  'legal',
  'founder',
  'other',
] as const;
export type RoleFamily = typeof ROLE_FAMILIES[number];

export const ROLE_SENIORITIES = [
  'ic_junior',
  'ic_mid',
  'ic_senior',
  'lead',
  'manager',
  'director',
  'vp',
  'cxo',
  'unknown',
] as const;
export type RoleSeniority = typeof ROLE_SENIORITIES[number];

export interface RoleClassification {
  family: RoleFamily;
  seniority: RoleSeniority;
  is_exec: boolean;
}

export interface HiringFilter {
  include_families?: RoleFamily[];
  include_seniorities?: RoleSeniority[];
  exclude_families?: RoleFamily[];
  always_include_exec?: boolean;
}

// Match the small-classifier model already in use elsewhere (source_curator).
const CLASSIFY_MODEL = 'deepseek-v4-flash';

function titleHash(title: string, department: string | null | undefined): string {
  const key = `${title.toLowerCase().trim()}|${(department ?? '').toLowerCase().trim()}`;
  return createHash('sha256').update(key).digest('hex');
}

function coerceFamily(s: unknown): RoleFamily {
  return (ROLE_FAMILIES as readonly string[]).includes(String(s)) ? (s as RoleFamily) : 'other';
}
function coerceSeniority(s: unknown): RoleSeniority {
  return (ROLE_SENIORITIES as readonly string[]).includes(String(s)) ? (s as RoleSeniority) : 'unknown';
}

const SYSTEM_PROMPT = `You classify job titles into a fixed taxonomy. Be terse and deterministic.

family — pick exactly one:
- sales            (AE, SDR, BDR, account executive, sales rep, sales director, sales engineer)
- gtm              (head of go-to-market, generalist GTM, partnerships, alliances)
- revops           (revenue operations, sales operations, GTM systems)
- growth           (growth lead, growth engineer, lifecycle, performance marketing)
- customer_success (CSM, customer success, account management retention-focused, support)
- marketing       (content, brand, demand-gen, product marketing, communications)
- engineering     (software/hardware/embedded/security/devops/infra/QA/SRE)
- product         (product manager, product lead, head of product)
- design          (UX, UI, visual, brand design, design lead)
- data            (data engineer, data analyst, data scientist non-ML, BI)
- ml_ai           (ML engineer, AI engineer, ML researcher, applied scientist)
- ops             (general operations, business ops, supply chain, biz dev non-sales)
- finance         (finance, accounting, FP&A, treasury, controller)
- people          (HR, recruiting, talent, people ops, L&D)
- legal           (legal, compliance, GC)
- founder         (founder, co-founder, founding role across any function)
- other           (use ONLY when no category fits — never as a default)

seniority — pick exactly one:
- ic_junior  (intern, junior, associate, I)
- ic_mid     (no qualifier or "II", typical staff IC)
- ic_senior  (senior, staff, principal IC, lead engineer in IC track)
- lead       (team lead, tech lead, squad lead — leading without people management)
- manager    (manager, engineering manager, sales manager)
- director   (director of X, head of <function below VP>)
- vp         (VP of X, SVP)
- cxo        (CEO, CTO, CFO, COO, CRO, CMO, chief of staff at C-level, founder when listed as founder/CEO)
- unknown    (when title gives no seniority signal at all)

is_exec — true if VP+, "Head of <whole function>", or C-level. Otherwise false.

Output strictly valid JSON: {"family":"...","seniority":"...","is_exec":true|false}`;

/**
 * Classify one title. Returns cached result if present, otherwise calls the
 * LLM, persists to `role_classifications`, and returns.
 *
 * `workspace_id` is required because the LLM call goes through
 * chatCompleteForWorkspace (which resolves API keys from policy/env per
 * workspace). The cached row itself is global — any workspace's cache miss
 * benefits all future workspaces.
 */
export async function classifyRole(
  sb: SupabaseClient,
  workspace_id: string,
  title: string,
  department: string | null | undefined = null,
): Promise<RoleClassification> {
  const hash = titleHash(title, department);

  const cached = await sb
    .from('role_classifications')
    .select('family, seniority, is_exec')
    .eq('title_hash', hash)
    .maybeSingle();
  if (cached.data) {
    return {
      family: coerceFamily(cached.data.family),
      seniority: coerceSeniority(cached.data.seniority),
      is_exec: Boolean(cached.data.is_exec),
    };
  }

  const userPrompt = `title: ${title}${department ? `\ndepartment: ${department}` : ''}`;
  const llm = await chatCompleteForWorkspace(sb, workspace_id, {
    model: CLASSIFY_MODEL,
    behavior: 'connector_extract',
    max_tokens: 60,
    // A job title in, three fields out. 60 tokens is the right size for the
    // answer and far too small for a reasoning model to reach it, so with
    // thinking on this call returned nothing and every uncached title was
    // answered by the 4000-token retry instead.
    thinking: 'disabled',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  let parsed: { family?: unknown; seniority?: unknown; is_exec?: unknown } = {};
  try { parsed = JSON.parse(llm.text); } catch { /* fall through to defaults */ }

  const result: RoleClassification = {
    family: coerceFamily(parsed.family),
    seniority: coerceSeniority(parsed.seniority),
    is_exec: Boolean(parsed.is_exec),
  };

  // Persist (best-effort — a race between two workspaces classifying the
  // same title at once just means one INSERT wins; both end up using the
  // same value next time).
  await sb.from('role_classifications').upsert({
    title_hash: hash,
    title,
    department: department ?? null,
    family: result.family,
    seniority: result.seniority,
    is_exec: result.is_exec,
  }, { onConflict: 'title_hash' });

  return result;
}

/**
 * Decide whether a classified posting passes the workspace's filter.
 *
 * Rules:
 * - Empty / missing filter → pass everything (today's behavior; no policy means
 *   no filtering).
 * - include_families: if set and non-empty, family must be in the list.
 * - include_seniorities: if set and non-empty, seniority must be in the list
 *   OR (always_include_exec && is_exec).
 * - exclude_families: if set, drop when family matches (overrides include).
 */
export function passesHiringFilter(
  c: RoleClassification,
  filter: HiringFilter | null | undefined,
): boolean {
  if (!filter) return true;
  const { include_families, include_seniorities, exclude_families, always_include_exec } = filter;

  if (exclude_families && exclude_families.length > 0 && exclude_families.includes(c.family)) {
    return false;
  }
  if (include_families && include_families.length > 0 && !include_families.includes(c.family)) {
    return false;
  }
  if (include_seniorities && include_seniorities.length > 0) {
    const senOk = include_seniorities.includes(c.seniority);
    const execOk = Boolean(always_include_exec) && c.is_exec;
    if (!senOk && !execOk) return false;
  }
  return true;
}
