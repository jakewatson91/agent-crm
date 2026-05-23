import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = resolve(__dirname, '../receipts');

export type Platform = 'agent-crm' | 'hubspot';

export interface ReceiptMeta {
  platform: Platform;
  account: string;
  run: number;
  stage: string;
  model?: string;
}

export function saveReceipt(meta: ReceiptMeta, payload: unknown): string {
  const dir = resolve(RECEIPTS_DIR, meta.platform);
  mkdirSync(dir, { recursive: true });
  const safeName = meta.account.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${safeName}_run${meta.run}_${meta.stage}.json`;
  const path = resolve(dir, filename);
  const body = {
    ...meta,
    timestamp: new Date().toISOString(),
    payload,
  };
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}
