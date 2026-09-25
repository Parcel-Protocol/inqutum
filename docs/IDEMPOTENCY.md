# Idempotent writes

Issue #44. A client, worker or wallet that retries a write must not create a second
invoice or apply a payment twice. This covers HTTP retries through the
`Idempotency-Key` header. Payment attribution (one transaction settles one
invoice) is a different guarantee and is described in
[VERIFY-IDEMPOTENCY.md](./VERIFY-IDEMPOTENCY.md).

## Which writes

| Route | Retry hazard without a key |
| ----- | -------------------------- |
| `POST /api/invoices` | A timed-out create is retried and a second invoice appears. |
| `POST /api/invoices/:id/cancel` | The retry of a cancel that worked is refused with `INVALID_TRANSITION`, so the client believes it failed. |
| `POST /api/invoices/:id/verify` | The retry repeats the Horizon lookup, or reports "already paid" for a payment that just succeeded. |
| `POST /api/invoices/:id/simulate-payment` | Local testing only; same reasoning. |

## Using it

Send `Idempotency-Key: <value>` (8 to 255 characters from `A-Z a-z 0-9 _ . : -`; a
UUID works). Use **one key per intended action** and resend the *same* key only when
retrying that same request.

Keys are private to the caller: they are scoped to the authenticated actor (wallet,
operator token, or anonymous), so two sellers cannot collide or read each other's
responses.

The header is optional by default so existing clients keep working. Set
`REQUIRE_IDEMPOTENCY_KEY=true` to refuse writes that carry none. That is the
recommended production setting once every client sends keys; the bundled frontend
already does.

### What the server answers

| Situation | Response |
| --------- | -------- |
| First request | Runs normally. Success (2xx) is remembered. |
| Retry after success | The **stored status and body**, with `Idempotent-Replayed: true`. The side effect does not run again. |
| Retry after failure | Runs again. Failures are **not** remembered (see below). |
| Retry while the first is still running | `409` `IDEMPOTENCY_IN_PROGRESS`, with `Retry-After: 1`. |
| Same key, different request (other route or body) | `422` `IDEMPOTENCY_KEY_CONFLICT`. Nothing runs. |
| Key older than the retention window | `410` `IDEMPOTENCY_KEY_EXPIRED`. Nothing runs; send a new key. |
| Malformed key | `400` `IDEMPOTENCY_KEY_INVALID`. |
| Missing key while required | `400` `IDEMPOTENCY_KEY_REQUIRED`. |
| Key store unreachable | `503` `IDEMPOTENCY_STORE_UNAVAILABLE`, with `Retry-After`. |

"Different request" means a different method, path or body. The body is compared
canonically, so a client that reorders its JSON keys still replays.

### Why failures are not remembered

Replaying a failure traps the client in it. The common case is `verify`: a wallet
retries before Horizon has indexed the transaction, gets `404`, and retries again a
moment later. If the `404` were stored, the retry would keep receiving it forever
even after the payment became visible. So only 2xx outcomes are stored; a
non-2xx response, a thrown error, or a client disconnect releases the key and the
next attempt runs.

That is safe because a failed request leaves no side effect. State changes are
additionally guarded by the invoice lifecycle ([LIFECYCLE.md](./LIFECYCLE.md)), so
even a request that raced its own retry cannot apply a transition twice.

### Why the store fails closed

If the key store is down, a keyed write is refused with `503` rather than run
without protection. The client asked for retry safety; silently dropping it would
defeat the point.

## Ordering in the router

`requirePermission` → **idempotency** → rate limits / invoice ceiling → handler.

Idempotency sits before the rate limits and the ceiling on purpose. A retry of a
create that already succeeded is a replay, not new load, and must not be refused
because the system has meanwhile become busy or full.

## Storage

| Server | Store | Survives restart / shared across instances |
| ------ | ----- | ------------------------------------------ |
| MVP (`server-mvp.ts`) | `MemoryIdempotencyStore` | No. In-process, capped at 5,000 keys (oldest completed dropped first). |
| Postgres (`server.ts`) | `PostgresIdempotencyStore`, table `idempotency_keys` | Yes. |

Both implement the contract in `backend/src/idempotency/store.ts` and run the same
behavioural test suite.

**Migration:** the Postgres store needs the `idempotency_keys` table. Run
`npm run db:migrate` before deploying a frontend that sends keys; until then keyed
writes return `503`. Keyless requests never touch the table.

The atomic step is `INSERT ... ON CONFLICT DO NOTHING`, so of two simultaneous first
requests exactly one proceeds. A request that never finished (crashed process) holds
its lock for `IDEMPOTENCY_LOCK_SECONDS` (default 60) and then another request may
take over, again with a conditional update so only one waiter succeeds.

Stored responses are kept for `IDEMPOTENCY_TTL_SECONDS` (default 86,400) and the
row stays a further 7 days as a tombstone so a late retry gets `410` instead of
re-running. Expired rows are purged opportunistically (about once per 200 keyed
requests); no scheduler is needed.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `REQUIRE_IDEMPOTENCY_KEY` | `false` | Refuse writes without a key. |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | How long a key can replay. |
| `IDEMPOTENCY_LOCK_SECONDS` | `60` | How long an unfinished attempt is trusted. |

## Other retry sources

- **Payment monitor / workers.** Settlement is guarded by the lifecycle (a paid
  invoice cannot be paid again), by the transaction-hash claim (one transaction
  settles one invoice) and by the durable Horizon cursor. A replayed monitor record
  is therefore harmless. They do not use `Idempotency-Key`.
- **Wallets.** A wallet resubmitting the same signed transaction hits the same
  transaction hash, which the claim rejects for any second invoice.
- **Webhooks.** There are no inbound webhooks yet. When added, key them on the
  provider's event id through the same store.

## Known limits

- The memory store does not deduplicate across processes or restarts. Use Postgres
  where that matters.
- A response is replayed byte for byte, including the QR payloads on create, so a
  replay shows the original expiry rather than recomputing anything.
- A double click that fires two *separate* requests carries two different keys and
  creates two invoices. Keys protect retries of one request; preventing a double
  submit is the form's job (disable the button while pending).
