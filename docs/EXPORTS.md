# Data exports

Sellers can export their invoices as a structured, privacy-safe file.
Code: `backend/src/exports/export-service.ts`, `backend/src/routes/export.routes.ts`.

## Schema

Schema id `quittance.invoice-export`, **version 1**. Every export (JSON or CSV)
uses this fixed, allow-listed field set:

`id, memo, status, amount, assetCode, assetIssuer, description, createdAt, expiresAt, paidAt, paymentTxHash`

Seller, customer and payer names and emails are **never exported**. The
allow-list is explicit, so a new invoice column is not exported until someone
adds it here and bumps the version. Change rules: adding a field or renaming
one bumps `schemaVersion`; consumers should check it.

JSON exports are an object with generation metadata plus `records`:

| Field | Meaning |
| --- | --- |
| `schema`, `schemaVersion` | Format identity and version |
| `exportId`, `generatedAt` | Unique id and generation time |
| `expiresAt` | Retention deadline for the generated artifact |
| `scope.sellerPublicKey` | Whose data this is |
| `filters` | The status / date filters applied |
| `recordCount`, `truncated` | Row count; `truncated: true` if the record cap was hit |
| `fields` | The exported columns, in order |

CSV contains the header row plus records only (metadata is returned by
`POST /exports`). Cells starting with `= + - @` (or tab/CR) are prefixed with
`'` to prevent spreadsheet formula injection.

## Authorization

An export is generated for the requesting wallet only.
`sellerPublicKey` may be sent as an explicit scope, but must equal `requester`;
anything else is `403 EXPORT_FORBIDDEN`. A generated artifact can only be
downloaded by its owner; other wallets get `404`, indistinguishable from an
unknown id. Rows that are not the requester's are dropped even if storage
returns them.

> As with `GET /invoices`, wallet identity is asserted by the caller (the API
> has no signed authentication yet). Exports contain no personal data beyond
> what an invoice link already shows; bind `requester` to an authenticated
> wallet session when one exists.

## Retention and limits

| Setting | Default |
| --- | --- |
| Artifact retention | 24 h, then deleted (`410 EXPORT_EXPIRED` for the owner) |
| Artifacts kept per wallet | 20, oldest evicted first |
| Records per export | 10,000, then `truncated: true` |

Generation pages through storage 500 rows at a time. Every export writes a
`PROOF_EXPORTED` audit event (id, wallet, count, format; no row data).
Artifacts are held in process memory like the audit trail, so they do not
survive a restart; no migration or configuration is needed.

## API

```
POST /api/exports   { "requester": "G…", "format": "json|csv", "status": "PAID", "from": ISO, "to": ISO }
  -> 201 { …metadata, downloadPath }
GET  /api/exports/:id?requester=G…   -> file (Cache-Control: private, no-store)
```

## Browser print and share actions

The seller- and payer-facing actions live in `frontend/lib/export.ts`. They are
read-only: they render the invoice record the page already loaded, never accept
secret keys, never sign, and never write invoice state.

| Action | Success code |
| --- | --- |
| `downloadInvoiceCSV` | `EXPORT_DOWNLOADED` |
| `openInvoicePDF` | `EXPORT_OPENED` |
| `shareInvoiceByEmail` | `EXPORT_SHARED` |

Every failure returns `{ ok: false, code, message, category, retryable,
recoveryAction, remediation }` instead of throwing; `generateInvoicePDF` keeps
its throwing contract and raises an `ExportError` with the same metadata.
`generateInvoiceCSV` is pure, but rejects a missing or non-array invoice list
with `INVALID_EXPORT_REQUEST` instead of returning a header-only file that would
imply every invoice was exported. An empty array is a valid export and produces
the header row. Corrupted entries inside the array are skipped, so one bad
record cannot block the rest of the file.

| Code | Category | Retryable | Meaning |
| --- | --- | --- | --- |
| `INVALID_EXPORT_REQUEST` | VALIDATION | no | No usable invoice record (missing id or status), or a CSV export without an invoice list |
| `EXPORT_PROOF_UNAVAILABLE` | LIFECYCLE | no | Proof requested for an invoice that is not `PAID` |
| `INVALID_EXPORT_RECIPIENT` | VALIDATION | no | No client email, or one the mailto check rejects |
| `EXPORT_POPUP_BLOCKED` | INTERNAL | yes | The print window was blocked |
| `EXPORT_UNAVAILABLE` | INTERNAL | yes | No browser APIs (server render) |
| `EXPORT_FAILED` | INTERNAL | yes | The download, pop-up write, or email hand-off failed |

Codes, categories, `retryable`, `recoveryAction` and `remediation` follow the
same taxonomy as `backend/src/errors/error-taxonomy.ts`. The CSV and proof stay
byte-identical for the same invoice record, so a re-download is comparable with
the copy a user already holds.
