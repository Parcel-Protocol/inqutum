# Quotas and canonical signed payloads

## Quotas

The API reserves quota before initiating work that consumes storage, queue
capacity, Horizon calls, import processing, or search indexing. The protected
operations are `invoice_create`, `horizon_verify`, `email_enqueue`,
`import_row`, and `search_index`. A refusal is `429` with the stable code
`QUOTA_EXCEEDED`, a `Retry-After` header, and a `details.usage` object; callers
should wait until `resetsAt` rather than retrying immediately.

The MVP quota ledger is in-process and resets on restart. Deployments with more
than one API instance must replace `QuotaManager` with a shared store before
relying on quotas as a global cost boundary.

Maintainers can inspect usage with `GET /api/quotas?actor=<id>&resource=<id>`.
They may apply a narrowly-scoped, time-window override with
`POST /api/quotas/overrides` or clear a bucket with `POST /api/quotas/reset`.
Both endpoints require a maintainer token. Overrides require a reason and are
limited to additional units in the current normal window; they are not an
unbounded bypass.

Example override:

```json
{
  "operation": "import_row",
  "actor": "G...SELLER",
  "resource": "csv",
  "extraUnits": 500,
  "reason": "approved migration batch"
}
```

## Canonical signed data

New cancellation clients sign a domain-separated canonical message:

```
inqutum.canonical.v1:cancel-invoice:{"invoiceId":"...","sellerPublicKey":"..."}
```

Object keys are sorted; surrounding and repeated whitespace is normalized;
Stellar keys and asset codes are uppercased; transaction hashes and invoice IDs
are lowercased; decimal amounts have insignificant zeros removed. Arrays retain
their original order. This prevents equivalent request shapes from producing
different signatures or hashes.

The cancellation verifier continues to accept the historic raw invoice-id and
`cancel:<invoice-id>` signatures during migration, so existing clients and
stored retry records remain usable. New integrations should only produce the
versioned form above.

Validate locally:

```bash
cd backend
npm test -- --test-name-pattern='quota|canonical'
npm run typecheck
```
