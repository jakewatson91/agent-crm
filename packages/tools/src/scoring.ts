/**
 * ICP-anchored entity scoring. Workspace-wide formula, source-agnostic.
 *
 * Inputs:
 *   - entity facts (predicate, object_text, confidence)
 *   - workspace.icp jsonb (free-form ICP description: industries, stages, sizes, etc.)
 *   - workspace.about (optional context)
 *
 * Output:
 *   - icp_fit: number in [0, 1] — 1.0 = perfect fit, 0 = clear miss
 *   - breakdown: object with sub-scores per dimension (e.g. industry, stage, signal_strength)
 *   - reasoning: 1-2 sentence rationale for audit trail
 *
 * The score is asserted as a fact (predicate='icp_fit', object_text=<numeric string>),
 * supersedes the prior icp_fit fact for the entity. Drafters read this and gate
 * if the score is below threshold.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { act } from '@agent-crm/primitives';

const SCORE_MODEL = 'gpt-4o-mini';

export interface EntityScore {
  icp_fit: number;
  breakdown: Record<string, number>;
  reasoning: string;
}

/**
 * Compute the score. Pure read; doesn't write.
 */
export async function scoreEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<EntityScore | null> {
  // Load entity + facts + workspace ICP/about
  const [entRes, factsRes, wsRes] = await Promise.all([
    supabase.from('entities').select('id, name, kind, attributes').eq('id', entity_id).maybeSingle(),
    supabase.from('facts').select('predicate, object_text, confidence')
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
      .is('supersedes', null).order('observed_at', { ascending: false }).limit(40),
    supabase.from('workspaces').select('icp, about, persona').eq('id', workspace_id).maybeSingle(),
  ]);

  if (!entRes.data) return null;
  const entity = entRes.data as { name: string; kind: string; attributes: Record<string, unknown> };
  const facts = (factsRes.data ?? []) as Array<{ predicate: string; object_text: string | null; confidence: number }>;
  const ws = (wsRes.data ?? {}) as { icp?: Record<string, unknown>; about?: string; persona?: Record<string, unknown> };

  // No facts and no attributes worth reasoning about → low confidence, low score
  if (!facts.length && !Object.keys(entity.attributes ?? {}).length) {
    return { icp_fit: 0, breakdown: { coverage: 0 }, reasoning: 'No facts or attributes; insufficient signal to score.' };
  }

  const sysPrompt = `You score how well an account fits the workspace's ICP. Score is in [0, 1]:
  1.0 = perfect ICP fit (the kind of account this workspace was built to sell to)
  0.7 = strong fit on most dimensions
  0.4 = partial fit, some red flags
  0.0 = clear miss (wrong industry, wrong stage, wrong scale)

Return JSON only:
{
  "icp_fit": 0.0-1.0,
  "breakdown": { "<dimension>": 0.0-1.0, ... },
  "reasoning": "<1-2 sentences citing the facts that drove the score>"
}

Score sub-dimensions you actually have evidence for. Don't invent dimensions. Common ones: industry, stage, scale, ai_readiness, signal_strength.

Be calibrated. Most accounts in a discovery feed will be 0.3-0.6. Reserve >0.8 for accounts whose facts directly match the ICP description. Reserve <0.2 for clear misses.`;

  const userPrompt = `WORKSPACE ABOUT:
${(ws.about ?? '').slice(0, 600)}

WORKSPACE ICP:
${JSON.stringify(ws.icp ?? {}, null, 2)}

ACCOUNT: ${entity.name} (${entity.kind})

ATTRIBUTES:
${JSON.stringify(entity.attributes ?? {}, null, 2)}

FACTS (predicate=value, conf):
${facts.length ? facts.map((f) => `  ${f.predicate}=${f.object_text} (${f.confidence})`).join('\n') : '  (none)'}

Score this account.`;

  const llm = await chatComplete({
    model: SCORE_MODEL,
    max_tokens: 350,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  let parsed: any;
  try { parsed = JSON.parse(llm.text); } catch { return null; }
  const fit = typeof parsed.icp_fit === 'number' ? Math.max(0, Math.min(1, parsed.icp_fit)) : 0;
  const breakdown = (parsed.breakdown && typeof parsed.breakdown === 'object') ? parsed.breakdown as Record<string, number> : {};
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  return { icp_fit: fit, breakdown, reasoning };
}

/**
 * Score the entity AND assert the result as a fact. Idempotent: replaces any
 * prior icp_fit fact via supersede chain (same content_hash → idempotent insert).
 */
export async function scoreAndAssert(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  entity_id: string,
): Promise<EntityScore | null> {
  const score = await scoreEntity(supabase, actor.workspace_id, entity_id);
  if (!score) return null;

  // Look for existing icp_fit fact to supersede
  const existing = await supabase.from('facts').select('id, object_text')
    .eq('workspace_id', actor.workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'icp_fit')
    .is('supersedes', null)
    .maybeSingle();

  // Skip the write if the score is unchanged (avoid event-log noise)
  if (existing.data?.object_text === score.icp_fit.toFixed(2)) return score;

  if (existing.data) {
    await act(supabase, actor, {
      tool: 'supersede_fact',
      args: {
        subject_entity: entity_id, predicate: 'icp_fit',
        object_text: score.icp_fit.toFixed(2), confidence: 0.9,
        supersedes: existing.data.id,
      },
    });
  } else {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: { subject_entity: entity_id, predicate: 'icp_fit', object_text: score.icp_fit.toFixed(2), confidence: 0.9 },
    });
  }

  // Also assert breakdown JSON as a separate fact (optional, useful for audit)
  if (Object.keys(score.breakdown).length > 0) {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: {
        subject_entity: entity_id, predicate: 'icp_fit_breakdown',
        object_text: JSON.stringify(score.breakdown), confidence: 0.85,
      },
    });
  }
  return score;
}
