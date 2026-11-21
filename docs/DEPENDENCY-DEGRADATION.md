# Dependency degradation

Code: `backend/src/ops/dependency-degradation.ts` (the matrix),
`backend/src/ops/user-status.ts` (the user view),
`backend/src/routes/status.routes.ts` (`GET /api/status`).

Four external dependencies can fail: **Stellar Horizon**, **PostgreSQL**,
**Redis / job queue** and the **email provider**. The matrix records, for each,
its failure modes, the user-safe fallback per capability, a retry hint and the
runbook anchor below. A degraded dependency must never cause a false positive:
no invoice marked paid without proof, no notification reported as sent when it
was not.

## User-facing status (#381)

`GET /api/status` is public and unauthenticated. It always answers `200`; the
state is in the body.

```json
{
  "success": true,
  "data": {
    "generatedAt": "2026-11-01T00:00:00.000Z",
    "overall": "unavailable",
    "summary": "Some features are temporarily unavailable. Your data and payments are safe.",
    "stale": false,
    "features": [
      { "capability": "payment.verify", "label": "Payment confirmation", "state": "unavailable",
        "code": "STORAGE_UNAVAILABLE", "message": "Payments cannot be confirmed right now. …", "retryAfterSeconds": 15 }
    ]
  }
}
```

| `state` | Meaning |
| --- | --- |
| `operational` | Working normally. `code`, `message`, `retryAfterSeconds` are `null`. |
| `degraded` | Accepted but delayed (`defer` fallback), or the dependency is slow. |
| `unavailable` | Refused with a retry hint (`refuse` fallback); we will not guess an answer. |
| `unknown` | No probe has reported. Never blocks, never raises `overall`, and the UI shows nothing. |

`overall` is the worst known feature state, or `unknown` when nothing is known.
When any feature is unavailable the response carries `Retry-After` (the longest
hint).

### What is deliberately not exposed

Dependency names, error text, latencies, failure-mode codes, hosts and runbook
links. The payload is built from the matrix's user-safe copy only
(`validateMatrix` already rejects copy that leaks internals), and
`tests/user-status.test.ts` asserts no operator detail survives. Operators keep
the full picture at `GET /ops/dependencies` (admin only).

### Load and failure behaviour

Probes are not free and this route is public, so:

- one computed status is shared for 10 s (`ttlMs`); `Cache-Control: public, max-age=10`;
- concurrent callers share a single in-flight check;
- if the check runner itself throws, the last good status is served with
  `stale: true`, or an `unknown` status if there is none — never a 5xx.

Probes: Postgres (`SELECT 1`, Postgres server) and Horizon (`GET` the root
document, both servers). Redis and the email provider have no probe wired yet;
they report `unknown` until one is registered via `createStatusRouter({ probes })`.

### Frontend

`frontend/lib/service-status.js` re-validates the payload (unknown states
dropped, text length-capped and control characters stripped, retry hints capped)
and `ServiceStatusBanner` shows a polite `status` region only while something is
degraded or unavailable. It polls every 60 s while the tab is visible, keeps the
last notice if a check fails, and a dismissal lasts until the set of affected
features changes. Connectivity to the API itself stays with `ApiStatusBanner`.

## Edge cases

- **Slow, not down:** latency above `degradedLatencyMs` is `degraded` with the
  generic "responding more slowly" copy; no capability is blocked.
- **Several dependencies down:** the most severe fallback wins (refuse > defer).
- **No probes at all (e.g. a fresh deploy):** `unknown`, not `operational`.
- **Probe hangs:** counted as `down` after the per-probe timeout.

## Rollback

Purely additive. Removing the `createStatusRouter` mounts (and the
`ServiceStatusBanner` line in `frontend/app/layout.tsx`) restores the previous
behaviour; nothing is stored and no existing response shape changed.

## Runbook

### Stellar Horizon
Payment confirmation is deferred; invoices are unchanged and verification is
retried. Check the Horizon status page and `STELLAR_HORIZON_URL`.

### Postgres
Invoice create / read, payment verification and exports are refused (`503`).
Check pool exhaustion, failover (read-only transaction errors) and
`statement_timeout`.

### Redis queue
Jobs and notifications are accepted and processed once the queue recovers.
`READONLY` means a replica was promoted; `OOM` means `maxmemory` was reached.

### Email provider
Email is deferred; the invoice link still works. `535` means rotated
credentials; `421` / `429` means throttling.
