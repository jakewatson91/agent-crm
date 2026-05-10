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
