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

## Authorization and redaction

Who is asking decides which wallet they may export and how much of each column
they see. The decision lives in one pure function,
`resolveExportAccess` (`backend/src/exports/export-field-policy.ts`).

| Caller | May export | Viewer | Owns the artifact |
| --- | --- | --- | --- |
| Wallet session (`end_user`) | Only their own wallet (`requester` must equal the session wallet) | `owner` — every column | the wallet |
| `maintainer` / `service` token | Any seller (`sellerPublicKey`, else `requester`) | `operator` — redacted | the token (so the seller cannot download it) |
| No credentials (legacy) | Only the wallet they name | `public` — redacted (a wallet string is not proof of ownership) | the wallet |
| Invalid / expired credentials | Nothing: `401 EXPORT_UNAUTHENTICATED` | — | — |

Asking for another wallet's scope as an `end_user` or unauthenticated caller is
`403 EXPORT_FORBIDDEN`. The viewer is derived from the credential, never from the
request body, so a caller cannot ask to be treated as `owner`.

### Field policy

| Field | `owner` | `operator` | `public` |
| --- | --- | --- | --- |
| `memo` | full | masked (first 4 characters + `[REDACTED]`; shorter values fully redacted) | `[REDACTED]` |
| `description` | full | `[REDACTED]` | `[REDACTED]` |
| `paidAt`, `paymentTxHash` | full | full | `[REDACTED]` |
| all other columns | full | full | full |

Redaction replaces the value and keeps the column, so the schema (and
`schemaVersion`, still **1**) is unchanged and consumers need no branching.
`null` stays `null`. `memo` and `description` always pass through secret
scrubbing first, whoever asks.

Any caller may also send `redactFields: ["amount", ...]` (a subset of the
columns) to blank more columns, for example before sharing a file. A request can
only narrow what the viewer sees, never widen it; unknown column names are a
`400`. An unknown viewer fails closed to everything redacted.

The metadata and JSON file carry `viewer` and `redactedFields` (the columns
subject to redaction for this file). Every export writes a `PROOF_EXPORTED`
audit event with the viewer, the exported wallet and the redacted fields; an
operator export is recorded with actor type `maintainer`.

Artifacts are downloaded by their owner only. Another wallet, another operator,
and the seller of an operator-generated file all get `404`, indistinguishable
from an unknown id. A wallet session must still name its own wallet in
`requester`; naming another wallet's is a `404`.

> Without a credential, wallet identity is asserted by the caller, as with
> `GET /invoices`. Send a wallet session to have it enforced.

### Rollback and migration

Existing callers keep working, with one deliberate tightening: unauthenticated callers that name a wallet now receive the redacted `public` view instead of the full `owner` view. Authenticated wallet sessions are unchanged. `viewer` / `redactedFields` are new
metadata members; record columns and `schemaVersion` are unchanged. Artifacts
are in memory, so there is nothing to migrate. To roll back, revert the change;
no stored data depends on it.

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
POST /api/exports   { "requester": "G…", "format": "json|csv", "status": "PAID", "from": ISO, "to": ISO, "redactFields": ["description"] }
  -> 201 { …metadata, downloadPath }
GET  /api/exports/:id?requester=G…   -> file (Cache-Control: private, no-store)
```
