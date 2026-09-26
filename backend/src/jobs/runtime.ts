import { JobQueue, JobWorker } from './worker';
import { JobStore } from './job-types';
import { MemoryJobStore } from './memory-job-store';
import { PostgresJobStore } from './postgres-job-store';
import { RetentionService, summarisePlan } from '../retention/retention-service';

export const EXPIRE_PENDING_INVOICES_JOB = 'invoices.expire-pending';
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

export const RETENTION_SWEEP_JOB = 'retention.sweep';
/** Six hours. Shorter than the shortest retention window, so every cycle can make progress. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface JobHandlerDeps {
  /** Marks overdue PENDING invoices EXPIRED and returns how many changed. Must be idempotent. */
  expirePendingInvoices: () => Promise<number>;
  /**
   * Retention sweep (issue #61). Optional so deployments that have not wired a
   * store yet keep working; the handler is only registered when it is present.
   */
  retention?: RetentionService;
}

export function registerJobHandlers(worker: JobWorker, deps: JobHandlerDeps): JobWorker {
  worker = worker.register(EXPIRE_PENDING_INVOICES_JOB, async () => ({
    expired: await deps.expirePendingInvoices(),
  }));

  if (!deps.retention) return worker;

  /**
   * Report-only unless the payload sets `apply: true`. A scheduled sweep should
   * show a maintainer what it would remove and require an explicit, auditable
   * approval before destroying anything.
   */
  return worker.register(RETENTION_SWEEP_JOB, async (payload) => {
    const apply = (payload?.data as { apply?: unknown } | undefined)?.apply === true;
    if (!apply) {
      const plan = await deps.retention!.plan();
      return { applied: false, summary: summarisePlan(plan), wouldDelete: plan.wouldDelete };
    }
    const result = await deps.retention!.apply();
    return { applied: true, deleted: result.deleted, totalDeleted: result.totalDeleted };
  });
}

/**
 * One retention sweep per interval bucket, bucketed separately for report and
 * apply runs so approving a deletion never silently reuses an earlier report's
 * idempotency key.
 */
export function scheduleRetentionSweep(
  queue: JobQueue,
  now: Date = new Date(),
  intervalMs = RETENTION_SWEEP_INTERVAL_MS,
  apply = false
) {
  const bucket = Math.floor(now.getTime() / intervalMs);
  return queue.enqueue(RETENTION_SWEEP_JOB, { apply }, {
    idempotencyKey: `${RETENTION_SWEEP_JOB}:${bucket}:${apply ? 'apply' : 'report'}`,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 10_000 },
  });
}

export function startRetentionScheduler(queue: JobQueue, intervalMs = RETENTION_SWEEP_INTERVAL_MS): () => void {
  const enqueue = () =>
    scheduleRetentionSweep(queue, new Date(), intervalMs).catch((err) =>
      console.error('[retention] failed to schedule sweep:', err)
    );
  void enqueue();
  const timer = setInterval(enqueue, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Enqueues one expiry sweep per interval bucket. The bucket is part of the
 * idempotency key, so several instances (or a restart within the same minute)
 * produce a single job rather than duplicates.
 */
export function scheduleExpirySweep(queue: JobQueue, now: Date = new Date(), intervalMs = EXPIRY_SWEEP_INTERVAL_MS) {
  const bucket = Math.floor(now.getTime() / intervalMs);
  return queue.enqueue(EXPIRE_PENDING_INVOICES_JOB, {}, {
    idempotencyKey: `${EXPIRE_PENDING_INVOICES_JOB}:${bucket}`,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000 },
  });
}

export function startExpiryScheduler(queue: JobQueue, intervalMs = EXPIRY_SWEEP_INTERVAL_MS): () => void {
  const enqueue = () =>
    scheduleExpirySweep(queue, new Date(), intervalMs).catch((err) =>
      console.error('[jobs] failed to schedule expiry sweep:', err)
    );
  void enqueue();
  const timer = setInterval(enqueue, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function createJobStore(pool?: ConstructorParameters<typeof PostgresJobStore>[0]): JobStore {
  return pool ? new PostgresJobStore(pool) : new MemoryJobStore();
}
