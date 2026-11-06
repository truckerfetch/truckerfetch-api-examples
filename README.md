# TruckerFetch API examples

Executable Node.js and Python examples for published carrier research, bounded pagination, export jobs and signed webhooks. They use the live REST contract at `https://truckerfetch.com/api/v1/openapi.json`; all fixture data is synthetic.

[Documentation](https://truckerfetch.com/docs) · [MCP integration](https://github.com/truckerfetch/truckerfetch-mcp) · [Agent skills](https://github.com/truckerfetch/truckerfetch-agent-skills)

## First request

Public reference documentation requires no subscription. Customer API operations require active Pro access and a scoped REST key from [API keys](https://truckerfetch.com/dashboard/api/keys). Keep the key in a server environment or secret manager, never in a browser bundle, query string, committed file or conversation.

```bash
# Load TRUCKERFETCH_API_KEY securely; do not commit the real value.
curl --fail-with-body --max-time 30 \
  https://truckerfetch.com/api/v1/editions/latest \
  -H "Authorization: Bearer $TRUCKERFETCH_API_KEY"
```

REST uses `tf_…` keys. The [hosted MCP endpoint](https://truckerfetch.com/mcp) uses a separate OAuth grant and cannot use a REST key.

Node.js 24+ and Python 3.10+ examples need no third-party runtime dependencies:

```bash
node javascript/search.mjs
python3 python/search.py
```

These scripts inspect the latest edition and page through a bounded Texas/fleet search. They print source metadata and row counts; implement the commented destination hook to store permitted records. They stop with `page_bound_reached` if more data remains after the configured maximum. Handle this deliberately; do not mistake a bounded example for a complete import.

## Search and data meaning

```javascript
import { createClient, searchPages } from './javascript/client.mjs';
const request = createClient();
for await (const page of searchPages(request, { states: ['TX'] }, { maxPages: 10, limit: 20 })) {
  // Persist permitted page.data and its page.meta provenance atomically here.
}
```

Responses use `data`, `meta`, and an optional `next_cursor` (also present in metadata). Repeat the same filters/operation with the cursor unchanged. Cursors bind the owner, selection, published release and privacy generation; they are temporary, not permanent bookmarks. The latest edition can be `null` before publication. Preserve its actual date during a source delay.

USDOT, postal and docket identifiers stay strings. Unknown source values remain unknown. Reported contacts require `contacts:read` and are not guarantees of deliverability or marketing consent. `insurance:read` and a currently available insurance capability are required for insurance research. Filing anniversary, estimated renewal, verified expiration and filed cancellation are different date bases.

## Request an export

Review an exact selection and save its idempotency key before invoking either example. Example `selection.json`:

```json
{ "scope": "catalog", "filters": { "states": ["TX"], "fleet": { "min": 1, "max": 10 } } }
```

```bash
node javascript/export.mjs --selection selection.json --idempotency-key saved-request-001 --confirm
python3 python/export.py --selection selection.json --idempotency-key saved-request-001 --confirm
```

Choose **one** implementation for a logical request. Using the same key and identical selection replays that request; changing its payload under the key is a conflict. `--confirm` records your intent to enqueue the reviewed selection. REST exports do not have the hosted MCP browser-approval step. They require `exports:write` + `contacts:read`, with insurance permission for renewal exports. Sample exports belong to the dashboard and are not supported here.

A successful request returns `202` with the job ID/state. Save the ID and original request/key. Poll `GET /api/v1/exports/{id}` using `exports:read`; retain the same insurance permission for renewal jobs. Use a bounded polling interval, honor `Retry-After`, and stop at terminal failures. When ready:

```bash
node javascript/download.mjs <export-uuid> ./exports
```

The downloader reads an authenticated manifest, retrieves each same-origin part and verifies byte length and SHA-256. It keeps outputs partial until every part verifies and never overwrites existing CSV files. Each part is at most 2 MiB and each volume at most 32 MiB; this example additionally caps a download at 1,000 parts / 256 MiB. It does not follow storage URLs or load the full CSV into model context. Treat downloaded data as private and honor subsequent restrictions in downstream systems.

Historical edition unlocks require `data:read` + `archive:unlock`, an explicit date and saved key. A 409 `confirmation_required` may return an account review URL; open the trusted TruckerFetch URL, approve the exact request and repeat with the same key. An already expired edition cannot be reopened. The history window is the rolling 90 Eastern calendar dates, with the published latest retained during source delay.

## Webhooks

[javascript/webhook.mjs](javascript/webhook.mjs) and [python/webhook.py](python/webhook.py) verify the exact raw request bytes with the endpoint's one-time signing secret. They check the event ID, key ID, timestamp tolerance and constant-time HMAC before parsing.

Use a raw-body route in your web framework. A new endpoint first receives a signed `endpoint.verify` event containing a `challenge`. Validate its signature, event ID, key ID and timestamp with the same verifier before responding. For this verification event, return a 2xx response whose plain-text body is exactly the signed `event.challenge` string; do not JSON-encode it or return an empty acknowledgement. The destination becomes active only after this handshake succeeds.

For normal supported events, validate the event schema and store a unique event ID durably before returning 2xx, then process asynchronously. Duplicate and out-of-order delivery is possible. Reconcile resource references through your authenticated API client; never fetch an arbitrary URL supplied in an event body. Endpoint creation, secret rotation and replay controls remain in the TruckerFetch dashboard.

Both languages use the same deterministic [synthetic test vector](tests/webhook-vector.json). Its public key is only fixture material.

## Failures and limits

Clients reject foreign origins, credential-bearing URLs, redirects, unsupported paths and oversized responses. They use a 30-second request deadline and perform **no automatic retries**, including after export timeouts. Preserve mutation keys/selection for deliberate recovery.

API errors expose a stable code, HTTP status and safe request/retry metadata without echoing backend diagnostics. Current account limits are shared across REST and MCP: inspect `/usage` and honor the service's `Retry-After` value on 429. Additional credentials do not create additional allowance. On 401 check the correct credential surface; on 402 check active Pro; on 403 inspect scopes; on 409 resolve confirmation, selection or idempotency conflicts; on 410 obtain a fresh authorized cursor/artifact; on 503 back off and preserve the original logical operation.

## Tests

```bash
npm ci --ignore-scripts
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

Tests run offline with synthetic responses: pagination, invalid destinations, no mutation retries, secrets omitted from errors, redirect/size rejection, trusted review URLs, cross-language signature vectors, authenticated part checksums and no CSV overwrites. No real keys or customer records are needed.

MIT covers this example code, not customer data, TruckerFetch trademarks or hosted-service rights. See [SECURITY.md](SECURITY.md).
