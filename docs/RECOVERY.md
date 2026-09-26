# Disaster-recovery validation

After a restore, a migration or a failover, someone has to prove that the
records which matter are still consistent. `npm run validate:dr` answers one
question per invariant and nothing else: does the data still hold together?

It is safe to point at production during an incident. Every statement is a
`SELECT`, and the runner refuses any invariant that is not read-only so a
future edit cannot quietly turn a validation run into a data-mutating one.

## Running it

```bash
npm run validate:dr                      # human-readable, exit 1 on failure
npm run validate:dr -- --json            # machine-readable, for CI gating
npm run validate:dr -- --only invoices.duplicate_memo,invoices.invalid_amount
```

The exit code is the gate: `0` when every invariant holds, `1` when one or more
fail, `2` when the run itself could not complete (bad database, unknown
invariant id). The report carries `readOnly: true` so a stored report carries
its own guarantee.

## What it checks

Errors mean the data is inconsistent. Warnings mean it is suspicious but
self-consistent, usually a workflow that did not finish.

| Invariant | Severity | Catches |
|---|---|---|
| `invoices.missing_seller` | error | Invoices with no seller wallet, so they belong to nobody and cannot be listed, paid or exported. |
| `invoices.invalid_amount` | error | Zero or negative amounts, which the create path rejects; indicates a bad import or a corrupted restore. |
| `invoices.duplicate_memo` | error | Duplicate memos. Memos are the payment-matching key, so a duplicate can route a payment to the wrong invoice. |
| `invoices.duplicate_external_id` | error | The same import key on more than one invoice, breaking the idempotency guarantee in [`IMPORTS.md`](./IMPORTS.md). |
| `transactions.orphaned` | error | Transactions pointing at invoices that do not exist, so payment history is separated from what it settled. |
| `payment_events.orphaned` | error | Payment events with a missing invoice, so a payment's audit trail cannot be read back. |
| `invoices.paid_without_settlement` | error | `PAID` invoices with no transaction hash or paid timestamp. The settlement cannot be verified on chain. |
| `invoices.settled_but_not_paid` | error | Invoices with a transaction hash that are not `PAID`; revenue under-reports and the invoice may be payable twice. |
| `transactions.duplicate_tx_hash` | error | One Stellar transaction recorded as settling more than one invoice. |
| `invoices.pending_past_expiry` | warning | `PENDING` invoices past `expires_at`. Usually just a sweep that has not run since the restore. |
| `invoices.paid_after_expiry` | warning | Invoices paid after their payment window closed, which the verify path should have refused. |

## Reading the output

Each failure prints the offending row count, a short explanation, up to five
sample rows and the remediation. The sample cap keeps a report readable; the
count is always the true total, so a capped list is never mistaken for the full
list.

```
[FAIL] invoices.duplicate_memo — Invoice memos are unique
       2 offending row(s). The same memo appears on more than one invoice...
       - {"memo":"INV-2026-01","copies":"2","first_id":"..."}
       Fix: Treat as a payment-routing incident. Work out which invoice is
       authoritative before any cleanup...
```

## Re-checking one area

After a repair, re-run the invariants for that area rather than the whole
catalogue:

```bash
npm run validate:dr -- --only invoices.duplicate_memo
```

An unknown id fails with exit `2` and lists the known ids, so a typo in a
runbook is caught immediately rather than being a silent no-op that reports a
clean run.

## Adding an invariant

Add a `DR_INVARIANTS` entry with a stable `id`, a `SELECT`, and a `remediation`
string that says what a maintainer should actually do. The test suite enforces
that ids are unique, that remediation is longer than a sentence, and that no
statement in the catalogue writes. A new invariant is therefore cheap to add and
hard to add badly.

Related: [`RETENTION.md`](./RETENTION.md) for what may be deleted and what is
protected, [`OPS_HEALTH.md`](./OPS_HEALTH.md) for live operational drift.
