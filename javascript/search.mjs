import { createClient, searchPages, ApiError } from './client.mjs';
try {
  const request = createClient();
  const latest = await request('editions/latest');
  console.log(JSON.stringify({ latest_edition: latest.data, request_id: latest.meta?.request_id }));
  for await (const page of searchPages(request, { states: ['TX'], fleet: { min: 1, max: 10 } }, { maxPages: 10, limit: 20 })) {
    // Write page.data to your authorized destination here. Do not log contact payloads.
    console.log(JSON.stringify({ rows: page.data.length, source_updated_at: page.meta?.source_updated_at, release_id: page.meta?.release_id, more: Boolean(page.next_cursor ?? page.meta?.next_cursor) }));
  }
} catch (error) {
  console.error(JSON.stringify(error instanceof ApiError ? { code: error.code, status: error.status, ...error.details } : { code: 'example_failed' }));
  process.exitCode = 1;
}
