import { readFile } from 'node:fs/promises';
import { createClient, ApiError } from './client.mjs';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
try {
  if (!args.includes('--confirm') || !args.includes('--selection') || !args.includes('--idempotency-key')) throw new ApiError('usage: --selection selection.json --idempotency-key saved-key --confirm');
  const selection = JSON.parse(await readFile(option('--selection'), 'utf8'));
  if (!['catalog', 'edition', 'list', 'renewals'].includes(selection.scope)) throw new ApiError('invalid_export_scope');
  const request = createClient();
  const queued = await request('exports', { method: 'POST', data: selection, idempotencyKey: option('--idempotency-key') });
  console.log(JSON.stringify({ export_id: queued.data.id, state: queued.data.state }));
  // Save this ID and the original key/selection before adding polling or download.
  // Poll GET exports/{id}; when ready, run download.mjs. Never retry a changed payload with the saved key.
} catch (error) {
  console.error(JSON.stringify(error instanceof ApiError ? { code: error.code, status: error.status, ...error.details } : { code: 'example_failed' }));
  process.exitCode = 1;
}
