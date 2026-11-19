# Feature-flag rollout guard (#256)

`backend/src/ops/rollout-guard.ts` turns one risky feature flag on, watches a
health signal for a bounded window, then promotes it or rolls it back. A
rollback is not trusted until the guard has read the flag back and confirmed it
matches the state from before the rollout.

It builds on the audited [admin config](ADMIN_CONFIG_AUDIT.md) and the
[feature flags](FEATURE_FLAGS.md): every change the guard makes is a normal
config change with hash-chained audit evidence and a config version.

## Lifecycle

```
MONITORING --healthy window-----------> PROMOTED
MONITORING --threshold breach / lost
            signal / too little traffic-> ROLLBACK_PENDING --verified--> ROLLED_BACK
MONITORING --flag changed by hand-----> SUPERSEDED
```

`ROLLBACK_PENDING` is a visible, retryable state (`needsAttention: true`), not a
hidden failure.

## Operating it

All routes need the admin bearer token. The two that change state also need a
single-use capability token (`X-Capability-Token`, see
[CAPABILITY_TOKENS.md](CAPABILITY_TOKENS.md)).

| Step | Call | Capability action / target |
|------|------|----------------------------|
| Start | `POST /api/ops/rollouts` `{flag, reason, thresholds?, scope?}` | `rollout.start` / flag name |
| Watch | `POST /api/ops/rollouts/:id/evaluate` (call on a timer) | none |
| Inspect | `GET /api/ops/rollouts`, `GET /api/ops/rollouts/:id` | none |
| Abort | `POST /api/ops/rollouts/:id/rollback` `{reason}` | `rollout.rollback` / rollout id |

```jsonc
// POST /api/ops/rollouts
{
  "flag": "paymentAmountTolerance",
  "reason": "Stage tolerance on testnet before production",
  "thresholds": { "maxFailureRate": 0.05, "minSamples": 20, "observationMs": 900000, "maxSignalFailures": 3 },
  "scope": { "operations": ["invoice.verify"] }   // optional; default is all operations
}
```

Defaults are in `DEFAULT_THRESHOLDS`. `scope.operations` limits the health signal
to named operations in the metrics registry, so unrelated traffic cannot hide or
cause a regression.

When a rollout is `PROMOTED` the override is still process-local. Make it
durable by setting the flag's environment variable (for example
`FEATURE_PAYMENT_AMOUNT_TOLERANCE=true`) and restarting.

## Guarantees

- **Scoped.** One flag per rollout, one active rollout per flag, at most 5 active
  at once, fixed thresholds and window.
- **Fail safe.** If the baseline cannot be read, the flag is not touched. If the
  signal is lost for `maxSignalFailures` readings in a row, or the window ends
  with fewer than `minSamples` observations, the guard rolls back: it never
  assumes silence means health.
- **No change without evidence.** If the audit trail is down, the start is
  refused and nothing changes (503). A rollback blocked by the same outage stays
  `ROLLBACK_PENDING` and is retried by the next `evaluate` or `rollback` call.
- **Verified.** After restoring the override the guard re-reads the flag. It
  reports `ROLLED_BACK` only if the override and the effective value both match
  the pre-rollout state. Otherwise it stays `ROLLBACK_PENDING` and lists the
  `problems`.
- **No clobbering.** If someone changed the override while monitoring, the guard
  ends as `SUPERSEDED` and writes nothing.
- **Idempotent.** Re-evaluating or re-rolling back a finished rollout changes
  nothing and writes no audit event. Concurrent calls on one rollout are
  serialised, so a rollback happens once.
- **Restores exactly.** A rollout that began with no override clears it; one that
  began with an explicit override restores that value.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| Flag already on (env or override) | `409 NOTHING_TO_ROLL_OUT` |
| Second rollout for the same flag | `409 ROLLOUT_ALREADY_ACTIVE` |
| Counters go backwards (process restart) | Window is re-based; no negative rates |
| Config version moves during rollback | Version is re-read and the write retried (up to 3 times) |
| Failure spike with fewer than `minSamples` operations | Not trusted yet; keeps watching |
| Process restarts | Overrides and rollouts are lost together; the environment value applies again, which is the safe state |
| Rollback on a `PROMOTED` rollout | `409 ROLLOUT_FINISHED`; use a normal feature-flag change |

## Recovery

1. `GET /api/ops/rollouts` lists `needsAttention` ids.
2. `GET /api/ops/rollouts/:id` shows `lastError`, `rollbackVerification.problems`
   and the event log.
3. Fix the cause (for example restore the audit store), then call
   `POST /api/ops/rollouts/:id/evaluate`, or roll back with a new capability.
4. If it will not verify, clear the override directly with
   `PUT /api/ops/config/feature-flags/:flag` `{"enabled": null, ...}` and confirm
   `GET /api/health` shows the expected `features` value.

## Compatibility

Additive. No existing route, schema or flag behaviour changes. New capability
actions `rollout.start` and `rollout.rollback` are added to the allow-list.
Tests: `backend/tests/rollout-guard.test.ts`.
