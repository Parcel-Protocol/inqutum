import { JobQueue, JobWorker } from './worker';
import { JobStore } from './job-types';
import { MemoryJobStore } from './memory-job-store';
import { PostgresJobStore } from './postgres-job-store';

export const EXPIRE_PENDING_INVOICES_JOB = 'invoices.expire-pending';
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

export interface JobHandlerDeps {
  /** Marks overdue PENDING invoices EXPIRED and returns how many changed. Must be idempotent. */
  expirePendingInvoices: () => Promise<number>;
}

export function registerJobHandlers(worker: JobWorker, deps: JobHandlerDeps): JobWorker {
  return worker.register(EXPIRE_PENDING_INVOICES_JOB, async () => ({
    expired: await deps.expirePendingInvoices(),
  }));
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
