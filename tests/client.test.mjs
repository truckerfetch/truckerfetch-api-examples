import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient, searchPages } from '../javascript/client.mjs';
import { verifyWebhook } from '../javascript/webhook.mjs';
import { downloadExport } from '../javascript/download.mjs';
const key = 'tf_' + 'a'.repeat(43);
const id = '73cb9f39-5454-4dcb-bc4e-095efc9d0694';
test('safe search pagination preserves filters and forwards opaque cursors unchanged', async () => {
  const requests = [];
  const request = createClient({ key, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return Response.json({ data: [{ usdot: String(requests.length) }], meta: {}, ...(requests.length === 1 ? { next_cursor: 'opaque-cursor' } : {}) });
  } });
  let pages = 0;
  for await (const page of searchPages(request, { states: ['TX'] }, { maxPages: 2, limit: 10 })) { pages++; assert.equal(page.data.length, 1); }
  assert.equal(pages, 2);
  assert.deepEqual(JSON.parse(requests[1].init.body), { filters: { states: ['TX'] }, limit: 10, cursor: 'opaque-cursor' });
  assert.equal(requests[0].init.redirect, 'error');
});
test('repeated cursors and page bounds stop work', async () => {
  const request = async () => ({ data: [], next_cursor: 'same', meta: {} });
  await assert.rejects(async () => { for await (const unused of searchPages(request, {}, { maxPages: 3 })) void unused; }, /repeated_cursor/);
  await assert.rejects(async () => { for await (const unused of searchPages(request, {}, { maxPages: 1 })) void unused; }, /page_bound_reached/);
});
test('unsafe targets and endpoint injection are rejected before network', async () => {
  for (const baseUrl of ['https://attacker.test', 'https://u:p@truckerfetch.com', 'http://truckerfetch.com', 'https://truckerfetch.com/path', 'http://127.0.0.1:1']) assert.throws(() => createClient({ key, baseUrl }));
  const request = createClient({ key, fetchImpl: async () => { throw new Error('unexpected network'); } });
  for (const path of ['//attacker.test', '../keys', 'exports/' + id + '/parts/-1']) await assert.rejects(request(path), /unsupported_operation/);
});
test('exports send exact confirmed selection and never automatically retry 429', async () => {
  let calls = 0; let captured;
  const request = createClient({ key, fetchImpl: async (_, init) => { calls++; captured = init; return Response.json({ error: { code: 'rate_limited', message: key } }, { status: 429, headers: { 'Retry-After': '60' } }); } });
  await assert.rejects(request('exports', { method: 'POST', data: { scope: 'catalog' }, idempotencyKey: 'saved-key-1' }), error => error.details.retry_after === 60 && !JSON.stringify(error).includes(key));
  assert.equal(calls, 1); assert.equal(captured.headers['Idempotency-Key'], 'saved-key-1');
  await assert.rejects(request('exports', { method: 'POST', data: { scope: 'catalog' } }), /saved_idempotency_key_required/);
  assert.equal(calls, 1);
});
test('redirects and oversize responses fail without exposing credentials', async () => {
  await assert.rejects(createClient({ key, fetchImpl: async () => new Response('', { status: 302 }) })('editions/latest'), /redirect_rejected/);
  await assert.rejects(createClient({ key, fetchImpl: async () => new Response('x'.repeat(262145)) })('editions/latest'), /response_too_large/);
  await assert.rejects(createClient({ key, fetchImpl: async () => { throw new Error(key); } })('editions/latest'), error => error.message === 'network_error' && !JSON.stringify(error).includes(key));
});
test('webhook vector verifies raw bytes and rejects tampering, wrong key and stale timestamps', () => {
  const vector = JSON.parse(readFileSync(new URL('webhook-vector.json', import.meta.url)));
  const headers = new Headers({ 'TruckerFetch-Event-Id': vector.event_id, 'TruckerFetch-Key-Id': vector.key_id, 'TruckerFetch-Timestamp': vector.timestamp, 'TruckerFetch-Signature': vector.signature });
  const bytes = Buffer.from(vector.raw_body);
  assert.equal(verifyWebhook(headers, bytes, vector.key_id, vector.secret, Number(vector.timestamp)).type, 'edition.published');
  assert.equal(verifyWebhook(headers, Buffer.from(vector.raw_body + ' '), vector.key_id, vector.secret, Number(vector.timestamp)), null);
  assert.equal(verifyWebhook(headers, bytes, 'wrong-key', vector.secret, Number(vector.timestamp)), null);
  assert.equal(verifyWebhook(headers, bytes, vector.key_id, vector.secret, Number(vector.timestamp) + 301), null);
});
test('download checks authenticated bytes and never overwrites an existing CSV', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'truckerfetch-export-'));
  const bytes = Buffer.from('usdot,legal_name\n123,Synthetic fixture\n');
  const part = { index: 0, volume: 0, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const request = async path => path.endsWith('/download') ? { data: { parts: [part] } } : path.endsWith('/parts/0') ? bytes : { data: { state: 'ready' } };
  try {
    const files = await downloadExport(request, id, directory);
    assert.deepEqual(await readFile(files[0]), bytes);
    await assert.rejects(downloadExport(request, id, directory), /EEXIST/);
    assert.deepEqual(await readFile(files[0]), bytes);
    await assert.rejects(downloadExport(async path => path.endsWith('/parts/0') ? Buffer.from('tampered') : request(path), id, directory), /export_integrity_failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('download leaves a preexisting partial file untouched when exclusive creation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'truckerfetch-owned-partial-'));
  const bytes = Buffer.from('usdot\n123\n');
  const original = Buffer.from('prior or concurrent download contents');
  const target = join(directory, id + '-volume-0.csv');
  const temporary = target + '.partial';
  const part = { index: 0, volume: 0, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const request = async path => path.endsWith('/download') ? { data: { parts: [part] } } : path.endsWith('/parts/0') ? bytes : { data: { state: 'ready' } };
  try {
    await writeFile(temporary, original, { flag: 'wx' });
    await assert.rejects(downloadExport(request, id, directory), { code: 'EEXIST' });
    assert.deepEqual(await readFile(temporary), original);
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
