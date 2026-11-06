const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const routes = [
  ['GET', /^(account|usage|editions(?:\/latest)?|changes)$/],
  ['GET', new RegExp('^editions/' + UUID + '$', 'i')],
  ['GET', /^carriers\/[0-9]{1,16}(?:\/(?:authorities|insurance-filings))?$/],
  ['GET', new RegExp('^exports/' + UUID + '(?:/download|/parts/(?:0|[1-9][0-9]{0,5}))?$', 'i')],
  ['POST', /^(carriers\/search|renewals\/search|exports)$/],
  ['POST', new RegExp('^editions/' + UUID + '/(?:search|access)$', 'i')],
];
export class ApiError extends Error {
  constructor(code, status = null, details = {}) { super(code); this.name = 'ApiError'; this.code = code; this.status = status; this.details = details; }
}
export function trustedOrigin(value, allowLocalhost = false) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError('invalid_origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ApiError('invalid_origin');
  if (!(allowLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) && !(url.protocol === 'https:' && !url.port && ['truckerfetch.com', 'www.truckerfetch.com'].includes(url.hostname))) throw new ApiError('untrusted_origin');
  return url;
}
async function bytes(response, maximum) {
  if (Number(response.headers.get('content-length') || 0) > maximum) throw new ApiError('response_too_large');
  if (!response.body) throw new ApiError('invalid_response');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break;
      length += value.value.byteLength;
      if (length > maximum) throw new ApiError('response_too_large');
      chunks.push(value.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export function createClient({ key = process.env.TRUCKERFETCH_API_KEY, baseUrl = process.env.TRUCKERFETCH_BASE_URL || 'https://truckerfetch.com', fetchImpl = fetch, allowLocalhost = false } = {}) {
  const origin = trustedOrigin(baseUrl, allowLocalhost);
  return async (path, { method = 'GET', data, query = {}, idempotencyKey, raw = false } = {}) => {
    if (!routes.some(([verb, pattern]) => method === verb && pattern.test(path))) throw new ApiError('unsupported_operation');
    if (!/^tf_[A-Za-z0-9_-]{40,60}$/.test(key || '')) throw new ApiError('configure_rest_api_key');
    if ((path === 'exports' || path.endsWith('/access')) && method === 'POST' && !/^[-._:a-zA-Z0-9]{8,128}$/.test(idempotencyKey || '')) throw new ApiError('saved_idempotency_key_required');
    const url = new URL('/api/v1/' + path, origin);
    for (const [field, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(field, String(value));
    const headers = { Authorization: 'Bearer ' + key, Accept: raw ? 'application/octet-stream' : 'application/json' };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response, content;
    try {
      response = await fetchImpl(url, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (response.redirected || response.status >= 300 && response.status < 400) throw new ApiError('redirect_rejected', response.status);
      content = await bytes(response, raw && response.ok ? 2 * 1024 * 1024 : 262144);
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('network_error'); }
    let value;
    if (!raw || !response.ok) {
      try { value = JSON.parse(content.toString('utf8')); } catch { throw new ApiError('invalid_json', response.status); }
    }
    if (!response.ok) {
      const code = /^[a-z][a-z0-9_]{0,79}$/.test(value?.error?.code || '') && !value.error.code.includes(key) ? value.error.code : 'request_failed';
      const details = {};
      const retry = response.headers.get('Retry-After');
      if (/^\d{1,6}$/.test(retry || '')) details.retry_after = Number(retry);
      const requestId = response.headers.get('X-Request-Id');
      if (/^[a-zA-Z0-9-]{1,80}$/.test(requestId || '')) details.request_id = requestId;
      try {
        const review = new URL(value.confirmation_url);
        if (review.origin === origin.origin && !review.search && !review.hash && !review.username && !review.password && new RegExp('^/developer/confirm/' + UUID + '$', 'i').test(review.pathname)) details.confirmation_url = review.href;
      } catch { /* No trusted review link. */ }
      throw new ApiError(code, response.status, details);
    }
    return raw ? content : value;
  };
}
export async function* searchPages(request, filters, { maxPages = 10, limit = 50 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_page_bound');
  let cursor; const seen = new Set();
  for (let index = 0; index < maxPages; index++) {
    const page = await request('carriers/search', { method: 'POST', data: { filters, limit, ...(cursor ? { cursor } : {}) } });
    if (!Array.isArray(page.data)) throw new ApiError('invalid_search_response');
    yield page;
    cursor = page.next_cursor ?? page.meta?.next_cursor;
    if (!cursor) return;
    if (seen.has(cursor)) throw new ApiError('repeated_cursor');
    seen.add(cursor);
  }
  throw new ApiError('page_bound_reached');
}
