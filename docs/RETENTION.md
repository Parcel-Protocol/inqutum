# Data retention

Operational data has to be kept long enough to answer "what happened and who
saw it", without growing forever. This document is the human-readable half of
that decision; the enforceable half is
[`backend/src/retention/retention-policy.ts`](../backend/src/retention/retention-policy.ts),
where every window below is a `RetentionRule` with a recorded rationale.

## The two rules that matter

1. **Plan before destroy.** A sweep always reports what it *would* remove
   before it removes anything. The scheduled job is report-only unless the
   payload sets `apply: true`, so destruction requires an explicit, auditable
   decision rather than a timer.
2. **Settlement wins over age.** Anything tied to financial settlement or an
   audit trail is never purged because it got old. An invoice that was paid is
   financial record-keeping, and a local retention window has no authority over
   it. The sweep refuses to delete these even if it is misconfigured to try.

## Policy table

| Data set | Class | Window | Measured from | Purgeable | Why |
|---|---|---|---|---|---|
| `transactions` | settlement | 7 years | `processed_at` | no | A settled Stellar payment is financial record-keeping. Reported for visibility, never purged. |
| `paid_invoices` | financial | 7 years | `paid_at` | no | An invoice that was paid is an accounting record referenced by its settlement. |
| `audit_events` | audit | 2 years | `timestamp` | no | Held in a bounded in-memory store that already enforces its own cap; see below. |
| `payment_events` | support | 180 days | `created_at` | yes | Support reads this when a payer disputes a payment; six months matches the practical life of a dispute. |
| `cancelled_invoices` | operational | 180 days | `created_at` | yes | Settled nothing and has no settlement reference, so it is the cheapest class to reclaim. |
| `expired_invoices` | operational | 90 days | `created_at` | yes | Never payable; kept briefly so a seller can see why an invoice lapsed. |
| `completed_jobs` | operational | 30 days | `updated_at` | yes | Finished jobs are operational history, not evidence. |

Every purgeable window is shorter than every protected one, so cleanup can
never race ahead of the records that must survive.

### Why audit events are listed but never purged

Audit events are stored in `MemoryAuditStore`, a bounded in-memory repository
with a default cap of 5000 entries that evicts oldest-first. That cap *is* the
retention mechanism, so an age-based delete would be redundant and would
destroy evidence. The rule is listed so audit retention is visible in one place
instead of being an implicit constructor default. If audit events are ever
moved to a durable table, this rule and its SQL are the two things to revisit.

## What the sweep reports

`plan()` returns, per data set: how many rows are eligible, how many were held
back and *why* (`settled`, `notOldEnough`, `reportOnly`), the cutoff instant, and
whether the data set can be deleted at all.

```ts
const retention = new RetentionService(new PostgresRetentionStore(pool));

const plan = await retention.plan();
if (!plan.clean) console.log(summarisePlan(plan));
```

`plan.dryRun` is always `true`. `apply()` recomputes eligibility immediately
before deleting, so the destructive set always matches current data rather than
a plan that was reviewed minutes or hours ago.

## Running a sweep

The `retention.sweep` job runs on a six-hour interval, bucketed like the expiry
sweep, and is **report-only by default**.

```bash
# Report only (this is what the scheduler enqueues).
npm run worker

# Approve destruction for one bucket.
curl -s -X POST -H "Authorization: Bearer $JOBS_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"retention.sweep","data":{"apply":true}}' \
  localhost:3001/api/jobs | jq '.data.job.id'
```

Report and apply runs are bucketed under different idempotency keys, so
approving a deletion can never silently reuse an earlier report's key.

## Deletion is bounded

Each data set is deleted in batches (`batchLimit`, default 1000 rows per run)
ordered by the timestamp column, so a sweep cannot take a long lock on a large
table. Rows that are not deleted wait for the next sweep.

## Escalation, not automation

Two findings are deliberately not auto-fixed, because a retention sweep is the
wrong place to make a judgement about money:

- An invoice is marked `PAID` with no transaction hash. Verify against Horizon
  and escalate.
- A transaction is missing its invoice. Restore the invoice; the on-chain
  settlement is real even when the local record is missing.

Deleting either to make a report look clean destroys the evidence needed to
resolve the incident.
