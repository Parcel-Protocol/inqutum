# Invoice lifecycle

Issue #43. One state machine decides what may happen to an invoice. The backend
stores, the HTTP handlers and the UI all ask it; none of them re-derive the rules.

The machine lives in [`shared/invoice-lifecycle.ts`](../shared/invoice-lifecycle.ts).
It is plain data plus a few pure functions, so the API can publish it and tests
can assert it exhaustively.

## States and transitions

```
                 SETTLE                      ┌─────────┐
            ┌───────────────────────────────▶│  PAID   │◀──────────────┐
            │                                └─────────┘               │
       ┌─────────┐   CANCEL   ┌───────────┐                            │
       │ PENDING │───────────▶│ CANCELLED │── SETTLE_AFTER_CANCEL ─────┘
       └─────────┘            └───────────┘
            │  EXPIRE
            ▼
       ┌─────────┐
       │ EXPIRED │
       └─────────┘
```

| From        | Event                 | To          | Meaning |
| ----------- | --------------------- | ----------- | ------- |
| `PENDING`   | `SETTLE`              | `PAID`      | A verified payment settled the invoice inside its expiry window. |
| `PENDING`   | `CANCEL`              | `CANCELLED` | The seller cancelled an unpaid invoice. |
| `PENDING`   | `EXPIRE`              | `EXPIRED`   | The expiry time passed while unpaid. |
| `CANCELLED` | `SETTLE_AFTER_CANCEL` | `PAID`      | A payment was found for an invoice already cancelled (see [LATE_PAYMENT_POLICY.md](./LATE_PAYMENT_POLICY.md)). |

Everything else is illegal. `PAID` and `EXPIRED` are terminal. `(state, event)`
has at most one outcome, so the machine is deterministic.

Transitions are keyed by **event**, not by target state, because two events can
end in the same state (`SETTLE` and `SETTLE_AFTER_CANCEL` both reach `PAID`) and
the audit log has to tell them apart.

### What the machine does not decide: time

Whether a `PENDING` invoice is still inside its expiry window is a fact about the
clock, not the state. It stays a guard beside the write it protects
(`expires_at > NOW()` in SQL, the equivalent check in the memory store). A
payment that races expiry therefore lands as an `EXPIRED -> PAID` attempt and is
refused like any other illegal move.

## Enforcement

| Layer | How |
| ----- | --- |
| Memory store (`memory-storage.ts`) | `assertTransition` before every status write; `updateInvoice` refuses any status change the table does not list. |
| Postgres (`invoice.service.ts`) | The `UPDATE ... WHERE status = ...` guards stay (they are the race-safe part). When one matches no row, the service reads the row and asks the lifecycle *why*, so the refusal is identical to the memory store's. |
| HTTP handlers | `InvalidTransitionError` becomes `400` with `code: "INVALID_TRANSITION"`. |
| UI (`frontend/lib/invoice-lifecycle.js`) | `canCancelInvoice` / `canPayInvoice` ask the same table, plus the client-side clock projection. |

`GET /api/invoices/lifecycle` returns the machine (states, terminal flags,
transitions), so nothing has to copy it.

### Rejection contract

```json
{
  "success": false,
  "code": "INVALID_TRANSITION",
  "error": "Invalid invoice transition: PAID -> CANCELLED",
  "details": { "from": "PAID", "to": "CANCELLED" }
}
```

An unknown invoice id is `Invoice not found`, not an invalid transition. A
non-owner cancelling is refused as unauthorized *before* the state is considered.

## Audit events

State changes write to the same log payments already used (`payment_events` in
Postgres, an in-process list in the memory store):

| `eventType`         | `eventData` |
| ------------------- | ----------- |
| `INVOICE_CREATED`   | `{ to: "PENDING" }` |
| `INVOICE_CANCELLED` | `{ from, to, actor }` (`actor` is the seller wallet) |
| `INVOICE_EXPIRED`   | `{ from, to }` |
| `PAYMENT_CONFIRMED` | tx hash, payer, settlement context (unchanged) |

`InvoiceStorage.getAuditTrail(invoiceId)` returns them oldest first.

In Postgres the status write commits first and the audit row is written right
after. If the audit insert fails it is logged, not thrown: failing the request
would tell the caller a committed transition did not happen. The reconciliation
report (see [RECONCILIATION.md](./RECONCILIATION.md)) flags any state that has no
matching audit event.

## Changing the machine

Edit `INVOICE_TRANSITIONS` in the shared module. `tests/invoice-lifecycle.test.ts`
holds an independently written expected matrix and fails until both agree.
