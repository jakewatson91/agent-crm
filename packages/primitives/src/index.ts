// NOTE: re-exports use `.ts` extensions. Turbopack's bundler is broken on
// the `.js` → `.ts` extension-alias mapping for THIS package's barrel —
// even with `transpilePackages` and `turbopack.resolveExtensions` configured.
// Direct `.ts` works (consumers go through Turbopack and tsx, both of which
// accept `.ts` specifiers). Files inside the package can keep `.js` imports.
export * from './types.ts';
export { embed, vectorLiteral } from './embed.ts';
export { act, getEvent, type ActResult } from './act.ts';
export { subscribe } from './subscribe.ts';
export { gate, decideGate } from './gate.ts';
export { query } from './query.ts';
export { cite } from './cite.ts';
export { chatComplete, chatCompleteStream, type ChatCompleteArgs, type ChatCompleteResult, type ChatMessage, type ChatStreamDelta, type ToolSpec } from './llm.ts';
export { resolveModel, parseModelId, providerLabel, type ModelKeys } from './model_registry.ts';
export {
  relatedToEntity,
  contactsAt,
  entitiesFromSubject,
  currentRole,
  activeFacts,
  excludeSuperseded,
  findEntityByName,
  type RelatedEntity,
  type FactRow as RelationFactRow,
} from './relations.ts';
