# Bulk invoice imports

Import many invoices from a file, with a dry run first and a rollback path if
the run goes wrong. Code: `backend/src/imports/import-service.ts`,
`backend/src/routes/import.routes.ts`.

Related: [`EXPORTS.md`](./EXPORTS.md) is the outbound direction. **An export
cannot be imported** — see [Why exports are not importable](#why-exports-are-not-importable).

## API

One endpoint, mounted under `/api` on both servers:

```
POST /api/imports/invoices
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `payload` | array, or string | — | Rows for `json`; raw CSV text for `csv` |
| `format` | `"json"` \| `"csv"` | `"json"` | How to read `payload` |
| `dryRun` | boolean | **`true`** | Plan only. Writing needs an explicit `false` |
| `maxRows` | integer | `1000` | Guard rail; larger files must be split |

`dryRun` defaults to `true` on purpose: posting an import file cannot commit it
by accident. The intended flow is to post the identical payload twice.

```bash
# 1. preview
curl -X POST localhost:3000/api/imports/invoices -H 'content-type: application/json' \
  -d '{"payload":[{"externalId":"INV-1","sellerPublicKey":"G...","amount":25}]}'

# 2. commit, after reading counts and remediation
curl -X POST localhost:3000/api/imports/invoices -H 'content-type: application/json' \
  -d '{"dryRun":false,"payload":[{"externalId":"INV-1","sellerPublicKey":"G...","amount":25}]}'
```

The response is a plan:

| Field | Meaning |
| --- | --- |
| `dryRun` | Whether anything was written |
| `counts` | `create` / `update` / `skip` / `error` |
| `rows[]` | Per row: `row` (1-based), `action`, `externalId`, `reason`, `invoiceId` |
| `duplicateExternalIds[]` | Keys used more than once in this file |
| `remediation[]` | Ordered, actionable next steps |
| `rollback` | Applied runs only: `strategy`, `invoiceIds`, `note` |

## Format

Schema id `quittance.invoice-import`, **version 1**. Supported fields:

`externalId, sellerPublicKey, sellerName, sellerEmail, amount, assetCode, assetIssuer, description, customerName, customerEmail, expiresInDays`

Every row is validated by the same schema as `POST /api/invoices`, so an import
can never create something the create endpoint would have rejected — including
the asset rules: an issued asset needs `assetIssuer`, and `XLM` must not carry
one. `amount` must be positive and at most 1e9; `expiresInDays` is an integer
in the same 1–30 range as the create endpoint.

`json` accepts a bare array, an object with a `rows` / `invoices` / `data`
array, or a JSON string. `csv` accepts a header row plus data rows, with quoted
fields, `""` escapes and CRLF endings — the exact inverse of the export CSV
writer. In CSV, `amount` and `expiresInDays` are parsed as numbers and an empty
cell means "absent", so the schema default applies.

### externalId and idempotency

`externalId` is the row's identity in **your** system, stored in the new
`invoices.external_id` column (unique where present, matching the existing
`jobs.idempotency_key` pattern). Re-posting a file is therefore safe:

| Situation | Action |
| --- | --- |
| No `externalId` | `create` — every run. Nothing to match on |
| `externalId` unseen | `create` |
| Seen, descriptive fields identical | `skip` — no write |
| Seen, descriptive fields differ | `update` |
| Seen, an immutable field differs | `error` |
| Same `externalId` twice in one file | `error` on the later row |

`update` is limited to `description`, `customerName`, `customerEmail`,
`sellerName` and `sellerEmail`. Amount, asset, seller and lifecycle columns are
settled facts or security boundaries, so an import can never rewrite them; a row
that disagrees about one of those is an error rather than a silent no-op. This
is why an import can correct a typo in a description but cannot quietly reprice
an invoice.

Matching is **case-sensitive**, matching the database index: `INV-1` and `inv-1`
are different keys. Normalise before importing if you need case-insensitive
identity. `externalId` is limited to 255 characters and rejects control
characters.

## Dry run guarantees

`dryRun: true` performs **no persistent writes**. It resolves existing rows
through `getInvoiceByExternalId`, which is documented on the `InvoiceStorage`
contract as deliberately *not* applying the lazy invoice-expiry transition —
every other read path calls `markExpiredInvoices()`, which writes, and a
preview must not mutate the invoices it is previewing.

The `InvoiceStorage` interface therefore gained a read-only lookup separate from
`getInvoiceById`, plus `updateInvoiceMutableFields`. Both are implemented in
the Postgres and in-memory backends.

## Remediation

`remediation` is built from what actually failed, and the response also carries
a per-row `reason` naming the field.

**A row failed validation.** The reason names the field, e.g.
`row 4: sellerPublicKey: Invalid Stellar public key format`. The rest of the
file is unaffected. Fix the row and re-upload the **whole** file: imports are
idempotent, so already-imported rows come back as `skip` instead of duplicating.

**The same `externalId` appears twice in one file.** Both rows cannot be right,
and applying them in order would make the result depend on row order, so the
later row is rejected and the key is listed in `duplicateExternalIds`. Keep one
row per key.

**A row conflicts with an existing invoice.** The reason names the invoice and
the fields that disagree, e.g. `already exists as invoice <id>, but this row
changes amount`. Either drop those fields to re-import the descriptive fields
only, or change the invoice directly through its own endpoint.

**The file looks like an export.** The request is rejected with an explanation
rather than a list of confusing field errors — see below.

## Partial imports and rollback

Rows are applied independently. A row that throws is recorded as an `error` and
the run continues, so one bad row cannot discard the rest. The response tells
you exactly which rows landed.

Every applied run returns a `rollback` block listing **only the invoices that
run created**:

```json
{
  "strategy": "cancel-created",
  "invoiceIds": ["..."],
  "note": "To undo this import, cancel each of these 3 invoice(s) while they are still PENDING: ..."
}
```

To reverse an import, cancel those invoices while they are still `PENDING` —
`POST /api/invoices/:id/cancel` only transitions a pending invoice. If an
imported invoice has already been paid, it cannot be cancelled; that row is
outside what an import can undo, which is why the note names the invoices
explicitly.

Imports never delete and never modify financial fields, so created invoices are
the only thing that needs reversing.

## Why exports are not importable

An export is a read-only projection: it carries `id`, `memo`, `status`,
`paymentTxHash` and timestamps, and deliberately omits `sellerPublicKey` and
`expiresInDays` (and never contains seller or customer contact details).
Re-importing one would create invoices with no owner.

Rather than fail with a wall of "sellerPublicKey required", the import endpoint
detects that shape and says so, naming the fields an import file needs instead.

## Limits

- 1000 rows per request by default (`maxRows` to raise it per call). Larger
  files should be split so a failure is easier to reason about.
- One endpoint, no background job: a large import holds the request open. If
  you need much larger volumes, that is a follow-up, not this endpoint.
