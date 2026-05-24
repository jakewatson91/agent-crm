export {
  authorize,
  disconnect,
  execute,
  fetchUserProfile,
  getConnectionStatus,
  composioUserId,
  type AuthorizeResult,
  type ConnectionStatus,
  type ExecuteResult,
} from './client.ts';

export {
  TOOLKITS,
  findAction,
  getToolkit,
  listToolkits,
  type CuratedAction,
  type ToolkitCatalog,
} from './catalog.ts';

export { classifyUnknown, type ToolScope } from './scope.ts';
