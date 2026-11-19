# Partial failures

`backend/src/domain/partial-failures.ts` builds a report of operations that
started internally but did not finish in an external system (a background
job that died or keeps retrying, a payment seen on chain that never settled
its invoice). It is a pure function: it reads plain records and never retries or
resolves anything.

```ts
import { buildPartialFailureReport, jobsToOperations } from './domain/partial-failures';

const report = buildPartialFailureReport(jobsToOperations(jobs), { now: new Date() });
```

## What the report contains

- `unresolved`: open failures, most severe and oldest first.
- `summary`: counts by operation type, severity, age bucket (`under_1h`,
  `1h_to_24h`, `over_24h`) and how many are retryable. Resolved and ignored
  operations are counted but not listed.

Each failure carries its internal state, the external reference (tx hash or
job correlation id), attempts, and `links` to inspect it, retry it (only when
retryable and open) and read the remediation below. Error text goes through
`redactSecrets`, which strips Stellar secret seeds, bearer tokens, credentials
in URLs and `token=` / `password=` style values. Job stack traces are never
included.

## Severity

| Severity | When |
| -------- | ---- |
| `critical` | any `payment.*` operation (funds may be involved) |
| `error` | not retryable, or open longer than the stale window (24h by default) |
| `warning` | retryable and recent |

An operation with `resolvedAt` is resolved. One with `ignoredAt` has been
dismissed by an operator and should carry `ignoredReason`.

## Remediation

### job

Queued jobs with errors are retried by the worker on their backoff schedule.
Dead jobs have used up their attempts or failed with a non retryable error:
read the error history, fix the cause, then requeue from the dead letter set
(see [JOBS.md](JOBS.md)).

### payment

Treat the chain as the source of truth. Look the transaction up on Horizon and
settle the invoice through the normal verify path; see
[VERIFY.md](VERIFY.md).

## Tests

```bash
cd backend && node --import tsx --test tests/partial-failures.test.ts
```

## Operator dashboard UI (#383)

`/ops/failures` in the frontend is the screen for the API above. It is for
operators only: it asks for the admin bearer token (`JOBS_ADMIN_TOKEN`) and shows
nothing until the API accepts it.

| Piece | File |
|-------|------|
| Page | `frontend/app/ops/failures/page.tsx` |
| Component | `frontend/components/PartialFailureDashboard.tsx` |
| API client and view model | `frontend/lib/ops-failures.ts` |

What an operator can do:

- See unresolved failures, most urgent first, with a summary (unresolved,
  critical, retryable, needs the user).
- Filter by severity, operation, stale, retryable and needs-the-user. Each change
  re-queries the API; the server does the filtering.
- Open **Details** for the classified cause and the redacted error history.
- **Retry** a failure a retry can help. A failure only the user can fix (bad
  recipient, underpayment, wrong asset, memo mismatch, opt-out) shows what the
  user must do instead of a Retry button.

### Authorization

- The token is held in component memory only. It is never stored, put in a URL,
  rendered or logged; the field is a password input; **Sign out** and any `401`
  clear it and return to the sign-in form.
- `403 JOBS_ADMIN_DISABLED` is reported as "not enabled on this deployment", not
  as a bad token.
- Hiding Retry is a courtesy, not the control. The server still answers `422` for
  a user-action failure and `409` for a job that is not dead-lettered or is
  already running, and the screen shows that reason and refreshes the list.
- If `NEXT_PUBLIC_API_URL` is missing or invalid the page shows the configuration
  error instead of sending the token to a placeholder host.

### Retry and failure behaviour

| Situation | Behaviour |
|-----------|-----------|
| Double click on Retry | One request. The button is `aria-disabled` while it runs |
| Network error or 5xx on retry | Outcome unknown, so the same `Idempotency-Key` is kept. Pressing Retry again replays it and the server answers `duplicate` instead of requeueing twice |
| `409`, `404`, `422` on retry | A definitive answer: the key is dropped, the reason is shown, the list refreshes |
| List fails to load | Alert with the reason and **Try again**. Nothing was changed |
| Slow response arrives after a newer one or a sign-out | Ignored |
| Server sends markup in an error message | Rendered as text. Messages are also clipped to 300 characters |

### Recovery

If the list shows a failure that will not clear: open **Details** for the history,
fix the cause (or contact the user if it is marked), then **Retry**. If the screen
itself cannot load, the same data is available from
`GET /api/ops/partial-failures` with the admin token.

### Compatibility

Additive: one route, one component, one client module. The API, schemas and
existing screens are unchanged. Tests: `frontend/tests/ops-failures.test.js` and
`frontend/tests/partial-failure-dashboard.test.js` (which also runs axe over each
state).
