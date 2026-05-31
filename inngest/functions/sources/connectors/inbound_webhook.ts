/**
 * inbound_webhook — a PUSH source. Rows arrive at /api/ingest/webhook, not via
 * the dispatcher. This connector exists only so the source type is registered
 * (creatable in the Sources UI, has a config schema). Its pull `run` is a no-op.
 */
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';

export { inboundWebhookMeta as meta } from '../registry_meta.js';

const inboundWebhook: Connector = async (_ctx: ConnectorContext): Promise<ConnectorResult> => {
  // Push-only. Nothing to pull on a schedule.
  return { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
};

export default inboundWebhook;
