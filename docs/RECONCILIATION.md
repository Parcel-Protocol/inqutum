# Reconciliation

Issue #45. A read-only dry run that compares what the database says with what it
can be checked against, and reports drift with guidance on how to repair it. It
**never repairs anything itself**: there is no apply mode, in the CLI or over HTTP.

## Running it

```bash
# Against Postgres (DATABASE_URL), read-only:
npm run reconcile

# Against an exported snapshot, no database at all (local / CI):
npm run reconcile -- --input snapshot.json

# Machine-readable, and check against an exported ledger file:
npm run reconcile -- --input snapshot.json --settlements ledger.json --json

# Also fail the run on warnings (default fails on errors only):
npm run reconcile -- --fail-on warning
```

Over HTTP (operators and services only, see [ACCESS-CONTROL.md](./ACCESS-CONTROL.md)):

```
GET /api/reconciliation            # optional ?graceMinutes=0..1440
Authorization: Bearer <maintainer or service token>
```

Exit codes for scripting: `0` nothing at or above the threshold, `1` drift found,
`2` the run could not complete (bad arguments, unreadable input, database error).
A failed run is never reported as "clean".

### Snapshot format (`--input`)

```json
{
  "invoices":        [ { "id": "...", "sellerPublicKey": "G...", "amount": "10.0000000",
                         "assetCode": "XLM", "memo": "INV-...", "status": "PAID",
                         "paymentTxHash": "...", "payerPublicKey": "G...", "paidAt": "...",
                         "expiresAt": "..." } ],
  "auditEvents":     [ { "invoiceId": "...", "eventType": "PAYMENT_CONFIRMED", "eventData": { "txHash": "..." } } ],
  "settlements":     [ { "txHash": "...", "destination": "G...", "amount": "10.0000000",
                         "assetCode": "XLM", "memo": "INV-..." } ],
  "reportedRevenue": { "G...": { "XLM": 10 } }
}
```

Only `invoices` is required. Any omitted section means that check is **skipped and
reported as not verified**, never silently passed.

## Why it is safe to run anywhere

- The comparison is one pure function (`backend/src/domain/reconciliation.ts`) over
  plain data. It cannot touch a store.
- Reading goes through dedicated storage methods that never write.
  Ordinary reads apply the expiry sweep first, which writes; using them would change
  the data being checked and hide the very staleness we want to report.
- The CLI opens Postgres with `default_transaction_read_only=on` and refuses to
  continue if the server does not confirm it, so even a bug could not write.
- Tests assert that against Postgres only `SELECT` statements are issued, and that a
  stale invoice is still `PENDING` after a run.

## Invariants

Findings come in the four kinds the issue names.

| Kind | Code | Severity | Meaning |
| ---- | ---- | -------- | ------- |
| stale | `PENDING_PAST_EXPIRY` | warning | Still `PENDING` well past `expiresAt`; the expiry sweep did not run. Default grace 5 min. |
| inconsistent | `UNKNOWN_STATUS` | error | Status outside the lifecycle ([LIFECYCLE.md](./LIFECYCLE.md)). |
| inconsistent | `PAID_MISSING_PAYMENT_FIELDS` | error | `PAID` without tx hash, payer or `paid_at`. |
| inconsistent | `UNPAID_HAS_PAYMENT_FIELDS` | error | Not `PAID`, yet carries a payment reference. |
| inconsistent | `CANCELLED_MISSING_TIMESTAMP` | error | No `cancelled_at`, so late payments cannot be classified. |
| inconsistent | `SETTLEMENT_CONTEXT_MISMATCH` | error | `ON_TIME` / `AFTER_CANCEL` contradicts `settled_at` and `cancelled_at`. |
| inconsistent | `AUDIT_TX_MISMATCH` | error | Audit trail and invoice name different transactions. |
| inconsistent | `AUDIT_ORPHAN` | warning | Audit event for an invoice that does not exist. |
| inconsistent | `LEDGER_AMOUNT_MISMATCH` | error | Settlement amount differs from the invoice, compared to the stroop. |
| inconsistent | `LEDGER_ASSET_MISMATCH` | error | Different asset, or same code with a different issuer. |
| inconsistent | `LEDGER_DESTINATION_MISMATCH` | error | Settlement went to a different account than the seller. |
| inconsistent | `LEDGER_MEMO_MISMATCH` | error | Settlement memo differs from the invoice memo. |
| inconsistent | `REVENUE_MISMATCH` | error | A seller's shown balance differs from the sum of their `PAID` invoices. |
| duplicate | `DUPLICATE_INVOICE_ID` | error | Two rows share an id. |
| duplicate | `DUPLICATE_MEMO` | error | Two invoices share a memo; a payment cannot be attributed. |
| duplicate | `DUPLICATE_PAYMENT_TX` | error | One transaction recorded against several invoices. |
| duplicate | `DUPLICATE_SETTLEMENT_RECORD` | error | Same transaction twice in the settlement records. |
| missing | `AUDIT_EVENT_MISSING` | warning | A `PAID`/`CANCELLED`/`EXPIRED` invoice has no matching audit event. |
| missing | `PAID_WITHOUT_SETTLEMENT_RECORD` | warning | `PAID` with no settlement reference on file. |
| missing | `SETTLEMENT_UNAPPLIED` | **error** | Funds on file, invoice not `PAID`. Fix this first. |
| missing | `SETTLEMENT_UNKNOWN_INVOICE` | warning | A payment carries an `INV-` memo matching no invoice. |

Amounts are compared as integer stroops, never floats, so `0.1 + 0.2` cannot invent
drift.

### What "settlement references" are

- **Postgres:** the `transactions` table the payment monitor writes. The verify
  endpoint does **not** write to it, so a payment verified through the API has no row
  there. That is why `PAID_WITHOUT_SETTLEMENT_RECORD` is a warning and not an error.
- **Anywhere:** an exported ledger file passed with `--settlements` (for example
  built from Horizon), which is how to check against the chain itself.
- **Memory backend:** none are kept, so the ledger check is reported as not run.

### Expected noise

`AUDIT_EVENT_MISSING` will appear for invoices that predate the audit trail
(issue #43). It is a warning for that reason.

## Repair guidance

Every finding carries a `repair` field: what to check, which record to trust (the
on-chain transaction, then the invoice), and what to change. It is guidance for an
operator to act on deliberately. Nothing is applied.

The most urgent case is `SETTLEMENT_UNAPPLIED`: money arrived and the invoice does
not know. Re-run it through the normal verify path so the invoice settles through the
lifecycle (and gets its audit event) rather than editing the row by hand.

## Limits

- The balance check asks for each seller's stats, one small aggregate query per
  seller. Fine on demand or on a schedule; not a hot path.
- Balances are read back as JSON numbers, so sums beyond about 15 significant digits
  can lose the last stroop.
- It checks the database against itself and the references it holds. Unless you pass
  `--settlements` built from Horizon, it does not query the chain, so it cannot see a
  payment that was never recorded anywhere.
