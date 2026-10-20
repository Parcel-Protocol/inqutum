# Deterministic Chaos Testing

Suite: [`backend/tests/chaos-deterministic.test.ts`](../backend/tests/chaos-deterministic.test.ts).

Goal: exercise interrupted user and background workflows without flaky timing.
Every scenario uses one of:

- a fixed clock (`T0`/`at(offset)`),
- explicit lease and retry timestamps,
- a seeded PRNG (`DeterministicReplayEngine`),
- a deferred promise for concurrency interleavings.

There are **no `setTimeout` sleeps** and no assertions against wall-clock time.

## Scenarios

### 1. Interrupted email/proof side effect

Uses `runWithCheckpoint` + `MemoryCheckpointStore`:

| Scenario | Expected result |
|----------|-----------------|
| Process dies after claiming a send (stale `started`) | Becomes `in_doubt`; `perform` is not called again |
| Operator/provider reconciliation finds the send landed | Returns the provider result; no duplicate send |
| A recorded provider failure is retried | Exactly one deliberate second attempt |
| Two requests with the same key race | One runs; the other gets `CheckpointInProgressError` |

### 2. Interrupted background job

Uses `MemoryJobStore`:

| Scenario | Expected result |
|----------|-----------------|
| Worker A claims a job then dies | Worker B reclaims after the lease expires |
| Worker A tries to finish after losing its lease | Fenced out (`markSucceeded` returns `null`) |
| Worker B finishes | Job is `succeeded` exactly once |
| A transient failure is scheduled for retry | Not claimable before `runAt`; claimable at `runAt` with `attempts + 1` |
| A job is dead-lettered | `requeueDead` returns it to `queued` with a fresh attempt budget |

### 3. Stale read and concurrent retry

Uses `DeterministicReplayEngine` with seed `2026`:

- a settle request loses the network,
- the same idempotency key is retried and then delivered twice,
- a stale-version cancel races the settle,
- an unauthorized cancel races an authorized edit.

The same seed produces the exact same trace and final state on every run.
The assertions pin one settlement (`settledAmount = 100`), one idempotent hit,
one conflict, and one unauthorized rejection.

## Running

```bash
cd backend
npm test
# or only the chaos suite:
node --import tsx --test tests/chaos-deterministic.test.ts
```

## Failure modes and operator recovery

### Email/proof `in_doubt`

1. Check the provider log for the recipient and time window.
2. If delivered, mark the checkpoint `succeeded` with the provider result.
3. If not delivered, mark it `failed`; the next keyed request may send again.
4. Never delete the checkpoint to "retry" an unknown outcome.

See [`RECOVERY_CHECKPOINTS.md`](./RECOVERY_CHECKPOINTS.md) for the SQL and the
full state machine.

### Stale background job lease

- The reclaim is safe because the stale worker is fenced by `lockedBy` and
  `attempts`.
- Inspect `jobs` for `status = 'running'` with `locked_until < NOW()`.
- Dead jobs keep their full error history and can be requeued through
  `requeueDead` (or the ops endpoint) after the cause is fixed.

### Stale read / version conflict

- The client receives a conflict, re-fetches the current version, and retries.
- Do not replay a write with an old `expectedVersion`; the version check is the
  stale-read guard.
- `DeterministicReplayEngine` shows the same conflict is reproducible with the
  same seed, so a fix can be verified against the exact interleaving.

### Duplicate retries

- Use the same idempotency key for retries of the same logical operation.
- Reusing a key for a different payload is refused rather than replayed.

## Operational edge cases

- **Lease shorter than the handler:** increase the lease or make the handler
  resumable; the stale worker is still fenced, but more work is repeated.
- **Checkpoint stale window too short:** a slow but live send can be declared
  `in_doubt`. Keep the window above the provider timeout plus retries.
- **Checkpoint store unavailable:** keyed side effects fail closed (retryable)
  rather than running unrecorded.
- **Clock skew:** all tests use a supplied `now`; production must use the
  database/server clock consistently.
- **Dead-letter growth:** requeue or purge dead jobs only after the underlying
  cause is fixed.

## Rollback

This change is test- and documentation-only; it does not alter public APIs,
schemas, or runtime behavior. To roll back, revert the commit. No migration is
required.
