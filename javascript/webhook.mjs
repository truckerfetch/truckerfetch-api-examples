import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyWebhook(headers, rawBody, expectedKeyId, secret, nowSeconds = Date.now() / 1000) {
  const id = headers.get('TruckerFetch-Event-Id');
  const timestamp = headers.get('TruckerFetch-Timestamp');
  const signature = headers.get('TruckerFetch-Signature') || '';
  if (!id || headers.get('TruckerFetch-Key-Id') !== expectedKeyId || !/^\d+$/.test(timestamp || '') || !/^v1=[a-f0-9]{64}$/.test(signature)) return null;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '')) return null;
  const key = Buffer.from(secret, 'base64url'); if (key.length !== 32) return null;
  const expected = createHmac('sha256', key).update(id + '.' + timestamp + '.').update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) return null;
  try { const event = JSON.parse(Buffer.from(rawBody).toString('utf8')); return event.id === id && typeof event.type === 'string' ? event : null; } catch { return null; }
}
// Persist event.id uniquely before acknowledging 2xx. Validate event schemas and reconcile
// resource references through the authenticated API; never fetch arbitrary body URLs.
