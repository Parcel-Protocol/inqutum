# Public API

Every route is mounted under `/api`. This document is the human-readable half
of the contract; the declared surface lives in
[`backend/src/api/api-contract.ts`](../backend/src/api/api-contract.ts), and
[`tests/api-contract.test.ts`](../backend/tests/api-contract.test.ts) walks the
live Express router on every test run and fails if the two disagree **in either
direction**:

- a route that exists but is not documented here, or
- a route documented here that the server no longer serves.

The second direction is the one that earns its keep. Documentation that
silently outlives the code it describes is worse than none, because callers keep
building on a promise the server no longer makes.

To add a route, add the contract entry in the same change. The test will tell
you if you forget.

## Envelope

Success:

```json
{
  "success": true,
  "data": { "...": "payload" },
  "message": "optional human-readable note",
  "pagination": { "nextCursor": null, "hasMore": false },
  "correlationId": "optional request id, echoes the X-Correlation-Id header"
}
```

Failure:

```json
{
  "success": false,
  "error": "Import has 3 rows, which exceeds the limit of 2.",
  "code": "INVALID_IMPORT_PAYLOAD",
  "category": "validation",
  "retryable": false,
  "recoveryAction": "Split the file and import in batches.",
  "correlationId": "optional request id"
}
```

`error` is always a sentence a caller can show a user. `recoveryAction` is
present on the errors where retrying differently actually helps. When you
report a problem, include `correlationId`: it appears in the server log for the
same request.

## Authentication

Almost everything is public and scoped by the wallet address in the request.

Three areas are maintainer-only and require `Authorization: Bearer
$JOBS_ADMIN_TOKEN`, because they expose internal payloads and stack traces:

| Route | On a missing token | On a wrong token |
|---|---|---|
| `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/retry` | `401 UNAUTHORIZED` | `401 UNAUTHORIZED` |
| `GET /ops/health` | `403 JOBS_ADMIN_DISABLED` | `401 UNAUTHORIZED` |

The difference matters when debugging setup: `403 JOBS_ADMIN_DISABLED` means
`JOBS_ADMIN_TOKEN` is **unset on the server**, so the route is off entirely.
`401` means the token is configured but the request did not present it. See
[`OPS_HEALTH.md`](./OPS_HEALTH.md).

## Pagination

Cursor pagination ([`PAGINATION.md`](./PAGINATION.md)) for invoice lists, offset
for audit events, notifications and jobs. `GET /invoices` takes `cursor` and
`limit`; `GET /audit/events`, `GET /notifications` and `GET /jobs` take `limit`
and `offset`. All three return `pagination` in the success envelope.

## Routes

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness. Reports the storage mode. |
| GET | `/ready` | Readiness. Checks the database before accepting traffic. |

### Invoices

| Method | Path | Notes |
|---|---|---|
| POST | `/invoices` | Create. `externalId` is accepted for import parity and makes the call idempotent. |
| GET | `/invoices` | Cursor-paginated, `?sellerPublicKey=&cursor=&limit=`. |
| GET | `/invoices/stats` | Counts and totals for a seller. |
| GET | `/invoices/:id` | A `PENDING` invoice past its expiry is returned as `EXPIRED`. |
| GET | `/invoices/:id/payment-info` | What a payer needs: amount, asset, memo, expiry. |
| POST | `/invoices/:id/cancel` | Terminal. A cancelled invoice cannot be paid. |
| POST | `/invoices/:id/verify` | Verify a payment. Read-only. |
| POST | `/invoices/:id/simulate-payment` | Simulate against the network. Does not mutate the invoice. |

```bash
curl -s -X POST localhost:3001/api/invoices \
  -H 'content-type: application/json' \
  -d '{"sellerPublicKey":"GA5Z...","amount":25,"assetCode":"USDC","memo":"INV-2026-01","expiresInHours":72}' \
  | jq .data
```

```json
{
  "success": true,
  "data": { "id": "0f1c…", "status": "PENDING", "amount": "25.0000000", "memo": "INV-2026-01" }
}
```

A cancel of an already-paid invoice is the interesting failure. Note the status
is `400`, not `409`: the request is well-formed, the invoice is simply not in a
state that allows the transition.

```json
{
  "success": false,
  "error": "Only pending invoices can be cancelled",
  "code": "INVOICE_CANNOT_CANCEL",
  "category": "LIFECYCLE",
  "retryable": false,
  "recoveryAction": "Invoices that are already paid or expired cannot be cancelled."
}
```

### Bulk import

`POST /imports/invoices` — JSON or CSV, **dry run by default**, `dryRun: false`
to write. `maxRows` may only *tighten* the server's cap, never raise it. Full
format, duplicate handling and rollback:
[`IMPORTS.md`](./IMPORTS.md).

```bash
curl -s -X POST localhost:3001/api/imports/invoices \
  -H 'content-type: application/json' \
  -d '{"payload":[{"externalId":"INV-1","sellerPublicKey":"GA5Z…","amount":25}]}' \
  | jq '.data.counts'
```

```json
{ "create": 1, "update": 0, "skip": 0, "error": 0 }
```

A dry run that finds nothing to do says so in words rather than leaving you to
infer it from a zero:

```json
{ "success": true, "data": { "dryRun": true, "counts": { "create": 0, "update": 0, "skip": 1, "error": 0 } },
  "message": "Dry run only. Nothing was written." }
```

### Audit

| Method | Path | Notes |
|---|---|---|
| GET | `/invoices/:id/audit-trail` | Events for one invoice, oldest first. |
| GET | `/audit/events` | Offset-paginated. Filter by action, entity, actor, time window. |
| GET | `/audit/export` | Downloadable audit document. |

Audit retention is bounded and in-memory; see
[`RETENTION.md`](./RETENTION.md).

### Exports

| Method | Path | Notes |
|---|---|---|
| POST | `/exports` | Create an export job. |
| GET | `/exports/:id` | Fetch status and download URL. `410 EXPORT_EXPIRED` once past the retention window. |

### Notifications

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Offset-paginated. |
| GET | `/notifications/unread-count` | Unread count for a recipient. |
| POST | `/notifications/:id/read` | Mark one read. |
| POST | `/notifications/read-all` | Mark all read for a recipient. |

### Observability

| Method | Path | Notes |
|---|---|---|
| GET | `/observability/metrics` | Latency and error metrics as JSON. |
| GET | `/metrics` | The same metrics in Prometheus text format. |

### Jobs (admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/jobs` | Offset-paginated, `?status=&type=`. |
| GET | `/jobs/:id` | One job, including its errors. |
| POST | `/jobs/:id/retry` | Requeue a dead-lettered job. Idempotent per job. `409 JOB_NOT_DEAD` if it is not dead. |

See [`JOBS.md`](./JOBS.md).

### Ops (admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/ops/health` | Dead jobs, stale work, expiry drift, server errors. |

See [`OPS_HEALTH.md`](./OPS_HEALTH.md).

### Stellar

| Method | Path | Notes |
|---|---|---|
| GET | `/stellar/account` | Balances and sequence. |
| GET | `/stellar/payments` | Recent payments. |
| GET | `/stellar/transaction/:hash` | One transaction. `404 TRANSACTION_NOT_FOUND` if Horizon has no such hash. |
| POST | `/stellar/verify-payment` | Verify without an invoice, for reconciliation. |

### Reconciliation

| Method | Path | Notes |
|---|---|---|
| POST | `/payment/sync` | Manual payment-monitor sync. Intended for maintainers and tests. |

## Error codes

Every code below is a key in `DOMAIN_ERROR_TAXONOMY`
([`error-taxonomy.ts`](../backend/src/errors/error-taxonomy.ts)) or a literal
emitted by a route, and the test suite fails if this document or the contract
names a code the server never sends.

| Code | Status | Category | Meaning |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | VALIDATION | Input failed schema validation. The message names the offending field. |
| `SELLER_REQUIRED` | 400 | AUTHORIZATION | `sellerPublicKey` was missing or unusable. |
| `RECIPIENT_REQUIRED` | 400 | VALIDATION | `recipient` was missing on a notification route. |
| `INVALID_CURSOR` | 400 | VALIDATION | The pagination cursor is malformed or from a different query. |
| `INVALID_IMPORT_REQUEST` | 400 | VALIDATION | The import request body is not a valid import request. |
| `INVALID_IMPORT_PAYLOAD` | 400 | VALIDATION | The payload is not parseable JSON or CSV, or exceeds `maxRows`. |
| `INVALID_EXPORT_REQUEST` | 400 | VALIDATION | `sellerPublicKey` missing or malformed on export create. |
| `MISSING_TX_HASH` | 400 | SETTLEMENT | `txHash` is required and absent. |
| `INVALID_TX_HASH` | 400 | SETTLEMENT | `txHash` is not 64 hex characters. |
| `INVOICE_CANNOT_CANCEL` | 400 | LIFECYCLE | The invoice is paid, expired or cancelled, so it cannot be cancelled. |
| `INVOICE_NOT_PENDING` | 400 | LIFECYCLE | Only a `PENDING` invoice can accept payment. |
| `INVOICE_ALREADY_PAID` | 400 | LIFECYCLE | The invoice has already settled. |
| `INVOICE_EXPIRED` | 400 | LIFECYCLE | The payment window has elapsed. |
| `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `MEMO_MISMATCH`, `DESTINATION_MISMATCH` | 400 | SETTLEMENT | The payment does not match what the invoice asked for. See [`VERIFY.md`](./VERIFY.md). |
| `NETWORK_MISMATCH` | 400 | SETTLEMENT | The wallet is on a different Stellar network. |
| `NO_PAYMENT_OPERATION` | 400 | SETTLEMENT | The transaction has no direct payment to the seller. |
| `UNAUTHORIZED_SELLER` | 403 | AUTHORIZATION | The connected wallet did not create this invoice. |
| `CORS_ORIGIN_DENIED` | 403 | AUTHORIZATION | The request Origin is not allowed. |
| `EXPORT_FORBIDDEN` | 403 | AUTHORIZATION | The requester does not own this export. |
| `JOBS_ADMIN_DISABLED` | 403 | AUTHORIZATION | `JOBS_ADMIN_TOKEN` is unset, so the route is off entirely. |
| `UNAUTHORIZED` | 401 | AUTHORIZATION | Admin token missing or wrong. |
| `INVOICE_NOT_FOUND` | 404 | NOT_FOUND | No invoice has that id. |
| `EXPORT_NOT_FOUND` | 404 | NOT_FOUND | No export has that id. |
| `NOTIFICATION_NOT_FOUND` | 404 | NOT_FOUND | No notification has that id. |
| `JOB_NOT_FOUND` | 404 | NOT_FOUND | No job has that id. |
| `TRANSACTION_NOT_FOUND` | 404 | NOT_FOUND | Horizon has no such transaction. Retryable: ledger close takes ~5s. |
| `JOB_NOT_DEAD` | 409 | LIFECYCLE | The job is not in the dead-letter set, so there is nothing to retry. |
| `EXPORT_EXPIRED` | 410 | NOT_FOUND | The artifact is past its retention window. |
| `RATE_LIMITED` | 429 | RATE_LIMIT | Too many requests. Retryable. |
| `INTERNAL_ERROR` | 500 | INTERNAL | Unexpected failure. Retryable; quote the `correlationId`. |
| `HORIZON_UNAVAILABLE` | 503 | NETWORK | Stellar Horizon is unreachable. Retryable. |
