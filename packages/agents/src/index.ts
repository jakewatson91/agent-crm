// Agents package: subscription bundles + prompts.
//
// v0 ships an empty roster. Week 2 introduces the lightweight generic agents
// (summarizer, enricher, respondant) and wires their prompts into agent_run via
// dynamic import keyed by `agent.run` event payload.

export interface AgentSpec {
  name: string;
  description: string;
  /** subscriptions to register on workspace boot, expressed in flat MCP-tool shape */
  subscriptions: Array<{
    name: string;
    semantic_query: string;
    structured_filter?: Record<string, unknown>;
    threshold?: number;
  }>;
  /** subset of MCP tool names this agent is allowed to call */
  allowed_tools: string[];
  /** system prompt template */
  prompt: string;
}

export const REGISTRY: Record<string, AgentSpec> = {};

// Multi-step agent loop scaffolding + the first loop built on it (deep account
// qualification). The runner is the reusable part; qualify.ts is one use of it.
export {
  runAgentLoop,
  type LoopTool,
  type LoopToolCtx,
  type RunAgentLoopArgs,
  type RunAgentLoopResult,
  type LoopStopReason,
} from './runner.ts';
export {
  runQualification,
  buildQualificationTools,
  type RunQualificationParams,
  type RunQualificationResult,
} from './qualify.ts';
