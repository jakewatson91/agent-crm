/**
 * Read or set policy.llm.models for a workspace.
 *
 * Usage:
 *   pnpm tsx scripts/_cfg_workspace_models.ts <workspace_id>
 *       print what each behavior resolves to today, change nothing
 *   pnpm tsx scripts/_cfg_workspace_models.ts <workspace_id> <model-id>
 *       set models.default, so every behavior with no entry of its own uses it
 *   pnpm tsx scripts/_cfg_workspace_models.ts <workspace_id> <behavior>=<model-id> ...
 *       set named behaviors, leaving the rest alone
 *   pnpm tsx scripts/_cfg_workspace_models.ts <workspace_id> --clear
 *       drop every entry and go back to the built-in per-call defaults
 *
 * Model ids come from argv, never from this file. A bare id ("deepseek-v4-pro")
 * means DeepSeek direct; "<vendor>/<model>" rides the AI Gateway.
 *
 * Prefer the BARE form for DeepSeek. report.ts prices a run by looking its model
 * string up in DEFAULT_PRICING, whose keys are bare, so recording
 * "deepseek/deepseek-v4-pro" makes the daily cost line read NO RATE CONFIGURED
 * and quietly drops that model out of the total.
 */
import { createServerClient } from '@agent-crm/db';
import { MODEL_BEHAVIORS, resolveBehaviorModel, type ModelBehavior, type WorkspacePolicy } from '@agent-crm/tools';

// What each behavior's calling code passes when policy names nothing. Printed so
// the before/after shows what actually changes rather than a row of blanks.
const CODE_DEFAULTS: Record<ModelBehavior, string> = {
  drafter: 'deepseek-v4-flash',
  enricher: 'deepseek-v4-flash',
  scoring: 'deepseek-v4-flash',
  research_relevance: 'deepseek-v4-flash',
  research_planner: 'deepseek-v4-pro',
  research_brief: 'deepseek-v4-pro',
  intake: 'deepseek/deepseek-v4-pro',
  claim_poster: 'deepseek-v4-flash',
  connector_extract: 'deepseek-v4-flash',
  curator: 'deepseek-v4-flash',
  wizard: 'deepseek-v4-flash',
};

const VALID = new Set<string>([...MODEL_BEHAVIORS.map((b) => b.key), 'default']);

function render(policy: WorkspacePolicy, label: string) {
  console.log(`\n${label}  (llm.models = ${JSON.stringify(policy.llm?.models ?? null)})`);
  for (const b of MODEL_BEHAVIORS) {
    console.log(`  ${b.key.padEnd(20)} ${resolveBehaviorModel(policy, b.key, CODE_DEFAULTS[b.key])}`);
  }
}

async function main() {
  const [ws, ...rest] = process.argv.slice(2);
  if (!ws) {
    console.error('usage: _cfg_workspace_models.ts <workspace_id> [<model-id> | <behavior>=<model-id>... | --clear]');
    process.exit(1);
  }

  const sb = createServerClient();
  const got = await sb.from('workspaces').select('id, name, policy').eq('id', ws).maybeSingle();
  if (got.error) throw got.error;
  if (!got.data) { console.error(`no workspace ${ws}`); process.exit(1); }

  const before = (got.data.policy ?? {}) as WorkspacePolicy;
  console.log(`workspace: ${got.data.name}`);
  render(before, 'BEFORE');
  if (!rest.length) { console.log('\n(read only — pass a model id to change it)\n'); return; }

  const policy = JSON.parse(JSON.stringify(got.data.policy ?? {})) as Record<string, unknown>;
  const llm = (policy.llm ?? {}) as Record<string, unknown>;
  policy.llm = llm;
  const models = (llm.models ?? {}) as Record<string, string>;
  llm.models = models;

  if (rest[0] === '--clear') {
    delete llm.models;
  } else if (rest.length === 1 && !rest[0]!.includes('=')) {
    models.default = rest[0]!;
  } else {
    for (const arg of rest) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? '' : arg.slice(0, eq);
      const val = eq === -1 ? '' : arg.slice(eq + 1).trim();
      if (!VALID.has(key)) {
        console.error(`unknown behavior "${key}". one of: ${[...VALID].join(', ')}`);
        process.exit(1);
      }
      if (val) models[key] = val; else delete models[key];
    }
  }

  const upd = await sb.from('workspaces').update({ policy }).eq('id', ws);
  if (upd.error) throw upd.error;

  const after = await sb.from('workspaces').select('policy').eq('id', ws).maybeSingle();
  render((after.data?.policy ?? {}) as WorkspacePolicy, 'AFTER');
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
