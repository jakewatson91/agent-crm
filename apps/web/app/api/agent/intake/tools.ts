/**
 * Tool registry for the global chat agent (5.5b).
 *
 * Each entry is:
 *   - spec: the function-calling description the model sees
 *   - run:  the server-side handler that executes the call
 *
 * Most tools delegate to existing MCP tools (callTool) so behavior stays
 * consistent with the rest of the system. `extract_facts` is the one new
 * inline LLM call — it parses free-text into atomic facts, same shape the
 * enricher produces.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  callTool, scoreAndAssert, selectAction, loadActionContext,
  hasValueAlignedFact, lookupEntity, type ValueTheme, getPolicy,
  chatCompleteForWorkspace,
} from '@agent-crm/tools';
import { type ToolSpec } from '@agent-crm/primitives';
import { inngest } from '@agent-crm/inngest';

type Actor = { workspace_id: string; actor_kind: 'user'; actor_id: string };

export interface ToolRunCtx {
  supabase: SupabaseClient;
  actor: Actor;
  workspace_id: string;
}

export interface ToolHandler {
  spec: ToolSpec;
  run: (ctx: ToolRunCtx, args: any) => Promise<unknown>;
}

// ---------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------

const lookupEntityTool: ToolHandler = {
  spec: {
    name: 'lookup_entity',
    description: 'Fuzzy-search the workspace for an entity (account or contact) by name. Use this FIRST when the user mentions a company or person. Returns up to N matches with id, name, kind, and current icp_fit.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to search for. Fuzzy match — partial / case-insensitive ok.' },
        limit: { type: 'number', description: 'Max matches to return. Default 5.' },
      },
      required: ['name'],
    },
  },
  run: async (ctx, args: { name: string; limit?: number }) => {
    return await lookupEntity(ctx.supabase, ctx.workspace_id, { name: args.name, fuzzy: true, limit: args.limit ?? 5 });
  },
};

const getEntityTool: ToolHandler = {
  spec: {
    name: 'get_entity',
    description: 'Read full state for one entity by id: attributes, active facts, current scores. Use after lookup_entity confirms which entity you want.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    const ent = await ctx.supabase.from('entities').select('id, name, kind, attributes').eq('id', args.entity_id).maybeSingle();
    if (!ent.data) return { error: 'entity not found' };
    const facts = await ctx.supabase.from('facts')
      .select('id, predicate, object_text, confidence, observed_at')
      .eq('subject_entity', args.entity_id).is('supersedes', null).limit(50);
    return { entity: ent.data, facts: facts.data ?? [] };
  },
};

const createAccountTool: ToolHandler = {
  spec: {
    name: 'create_account',
    description: 'Create a NEW account entity. Use only when lookup_entity returns no match and you are confident the user is referring to a new company. Returns the new entity_id.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        domain: { type: 'string', description: 'Optional. Normalized hostname like "apollo.io".' },
      },
      required: ['name'],
    },
  },
  run: async (ctx, args: { name: string; domain?: string }) => {
    const r = await callTool(ctx.supabase, ctx.actor, 'create_account', {
      name: args.name,
      attributes: {
        domain: args.domain ?? `${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
        discovered_via: 'chat_intake',
        discovered_at: new Date().toISOString(),
      },
    });
    if (!r.ok) return { error: r.error };
    return { entity_id: r.target_id, name: args.name };
  },
};

const extractFactsTool: ToolHandler = {
  spec: {
    name: 'extract_facts',
    description: 'Read a free-text observation about an entity and propose atomic facts to assert. Use this AFTER identifying the entity. Does NOT write anything — returns proposed facts for the user to confirm.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        entity_name: { type: 'string', description: 'For LLM context.' },
        text: { type: 'string', description: 'The free-text observation, tweet, article excerpt, or note.' },
      },
      required: ['entity_id', 'entity_name', 'text'],
    },
  },
  run: async (ctx, args: { entity_id: string; entity_name: string; text: string }) => {
    const sys = `You extract atomic factual claims about a specific company from a free-text observation.

ATOMIC = one predicate, one value. Not "uses postgres and redis." → two facts.
VERBATIM-GROUNDED = only what's stated or directly implied. No speculation.

Predicate examples (use snake_case, choose what fits — these are illustrative, not exhaustive):
  hiring_for, headcount, team_size, raised_round, launched_product, target_market,
  uses_stack, integrates_with, customer_of, sales_motion, founder, location

Output JSON: {"facts":[{"predicate":"<snake_case>","object_text":"<value>","confidence":0.0-1.0},...]}

Confidence: 0.95 explicit ("hiring a VP of Sales"), 0.7 implied ("their team of 12"). Skip lower.

If the observation is not about this company, return {"facts":[]}.`;

    const user = `Company: ${args.entity_name}
Observation:
"""
${args.text}
"""

Return JSON.`;

    try {
      const llm = await chatCompleteForWorkspace(ctx.supabase, ctx.workspace_id, {
        model: 'deepseek/deepseek-v4-flash:free',
        behavior: 'intake',
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      });
      const parsed = JSON.parse(llm.text) as { facts?: Array<{ predicate: string; object_text: string; confidence?: number }> };
      return { facts: parsed.facts ?? [] };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), facts: [] };
    }
  },
};

const assertFactsTool: ToolHandler = {
  spec: {
    name: 'assert_facts',
    description: 'Write a batch of facts about an entity. Idempotent on content hash. Call ONLY after the user has confirmed the proposed facts from extract_facts.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              predicate: { type: 'string' },
              object_text: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['predicate', 'object_text'],
          },
        },
      },
      required: ['entity_id', 'facts'],
    },
  },
  run: async (ctx, args: { entity_id: string; facts: Array<{ predicate: string; object_text: string; confidence?: number }> }) => {
    let asserted = 0;
    const errors: string[] = [];
    for (const f of args.facts) {
      if (!f.predicate || !f.object_text) { errors.push(`skipped invalid fact: ${JSON.stringify(f)}`); continue; }
      const conf = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.85;
      const r = await callTool(ctx.supabase, ctx.actor, 'assert_fact', {
        subject_entity: args.entity_id,
        predicate: f.predicate.toLowerCase().replace(/\s+/g, '_'),
        object_text: f.object_text,
        confidence: conf,
      });
      if (r.ok) asserted++;
      else errors.push(r.error ?? 'unknown');
    }
    return { asserted, errors };
  },
};

const rescoreTool: ToolHandler = {
  spec: {
    name: 'rescore_entity',
    description: 'Recompute the entity score from its current active facts. Call this AFTER assert_facts so the new facts feed into the score.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    const r = await scoreAndAssert(ctx.supabase, { ...ctx.actor, actor_kind: 'user' }, args.entity_id);
    if (!r) return { error: 'scoring returned null (entity may be dropped)' };
    return { icp_total: r.icp_total, breakdown: r.breakdown };
  },
};

const proposeActionTool: ToolHandler = {
  spec: {
    name: 'propose_action',
    description: 'Evaluate what the action selector would do for this entity right now. Returns the categorical action (draft_outreach / watch_only / deep_research / drop / continue) plus reason and matched value theme if any. Call AFTER rescore_entity.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    // Pull the freshest sub-score facts + the policy themes.
    const factsRes = await ctx.supabase.from('facts')
      .select('predicate, object_text')
      .eq('workspace_id', ctx.workspace_id).eq('subject_entity', args.entity_id).is('supersedes', null);
    const facts = (factsRes.data ?? []) as Array<{ predicate: string; object_text: string | null }>;
    const readScore = (p: string) => {
      const f = facts.find((x) => x.predicate === p);
      const v = f ? parseFloat(f.object_text ?? '') : NaN;
      return Number.isFinite(v) ? v : 0;
    };
    const breakdown = {
      industry_match: readScore('score_industry_match'),
      stage_match: readScore('score_stage_match'),
      signal_strength: readScore('score_signal_strength'),
      evidence_depth: readScore('score_evidence_depth'),
      recency: readScore('score_recency'),
      graph_proximity: readScore('score_graph_proximity'),
      rrf_prefilter: 0,
    };
    const icpTotal = readScore('score_total') || readScore('icp_fit');

    // Get the entity's channel for recent-draft/research lookups
    const chan = await ctx.supabase.from('channels').select('id')
      .eq('workspace_id', ctx.workspace_id).eq('account_entity_id', args.entity_id).maybeSingle();
    const channel_id = chan.data?.id as string | undefined;
    const channelCtx = channel_id
      ? await loadActionContext(ctx.supabase, ctx.workspace_id, args.entity_id, channel_id)
      : { recent_draft_at: null, recent_research_at: null, dropped_until: null, cooldown_until: null };

    const ADMIN = new Set([
      'icp_fit', 'icp_fit_breakdown', 'domain', 'contact_lookup_attempted',
      'dropped_until', 'outreach_cooldown_until', 'last_outreach_at',
      'research_triggered', 'research_completed', 'score_total',
      'no_reply_marked', 'outreach_rejected_at', 'replied_at',
      'query', 'intent', 'item_url', 'published_at', 'matched_alias',
      'topic', 'source_url', 'source_title',
    ]);
    const substantive = facts
      .filter((f) => !ADMIN.has(f.predicate) && !f.predicate.startsWith('score_'))
      .map((f) => ({ predicate: f.predicate, object_text: f.object_text }));

    const policy = await getPolicy(ctx.supabase, ctx.workspace_id);
    const themes = (policy.drafter?.value_themes ?? []) as ValueTheme[];

    const decision = selectAction({
      workspace_id: ctx.workspace_id,
      entity_id: args.entity_id,
      breakdown, icp_total: icpTotal,
      recent_draft_at: channelCtx.recent_draft_at,
      recent_research_at: channelCtx.recent_research_at,
      dropped_until: channelCtx.dropped_until,
      cooldown_until: channelCtx.cooldown_until,
      facts: substantive, value_themes: themes,
    });

    return {
      icp_total: icpTotal,
      breakdown,
      decision,
      value_match: hasValueAlignedFact(substantive, themes),
    };
  },
};

const triggerDrafterTool: ToolHandler = {
  spec: {
    name: 'trigger_drafter',
    description: 'Fire a drafter run for this entity. Picks up the drafter subscription and runs the same flow a real signal would. The draft will land in the Inbox as an outreach_send gate for human approval. Use ONLY when propose_action returned draft_outreach AND the user said go.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    // Find an active drafter subscription in this workspace + the most recent
    // signal for this entity to use as the trigger payload.
    const sub = await ctx.supabase.from('subscriptions')
      .select('id, owner_id')
      .eq('workspace_id', ctx.workspace_id).eq('active', true).eq('agent_behavior', 'drafter')
      .limit(1).maybeSingle();
    if (!sub.data) return { error: 'no active drafter subscription in this workspace' };

    const sig = await ctx.supabase.from('signals').select('id, observed_at')
      .eq('workspace_id', ctx.workspace_id).eq('entity_id', args.entity_id)
      .order('observed_at', { ascending: false }).limit(1).maybeSingle();

    if (!sig.data?.id) {
      return { error: 'no recent signal for this entity — drafter needs one to anchor on. Wait for a source to fire or create_signal directly.' };
    }
    try {
      await inngest.send({
        name: 'agent.run',
        data: {
          workspace_id: ctx.workspace_id,
          agent: sub.data.owner_id as string,
          trigger_event: 'manual',
          subscription_id: sub.data.id as string,
          signal_id: sig.data.id as string,
        },
      });
      return { ok: true, subscription_id: sub.data.id, signal_id: sig.data.id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
};

// ---------------------------------------------------------------
// Registry
// ---------------------------------------------------------------

export const INTAKE_TOOLS: Record<string, ToolHandler> = {
  lookup_entity: lookupEntityTool,
  get_entity: getEntityTool,
  create_account: createAccountTool,
  extract_facts: extractFactsTool,
  assert_facts: assertFactsTool,
  rescore_entity: rescoreTool,
  propose_action: proposeActionTool,
  trigger_drafter: triggerDrafterTool,
};

export function intakeToolSpecs(): ToolSpec[] {
  return Object.values(INTAKE_TOOLS).map((t) => t.spec);
}
