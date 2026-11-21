import type { Job, JobStore } from './job-types';

/** Most dead jobs one retry call may requeue. Keeps a single call bounded. */
export const MAX_DEAD_LETTER_RETRY_BATCH = 100;

export class DeadLetterForbiddenError extends Error {
  constructor(actorId: string) {
    super(`Actor ${actorId} is not allowed to retry dead-letter jobs`);
    this.name = 'DeadLetterForbiddenError';
  }
}

export interface DeadLetterOperatorOptions {
  store: JobStore;
  /** Decides whether an actor may requeue dead jobs. Required: there is no default allow. */
  canRetry: (actorId: string) => boolean;
  now?: () => Date;
}

export interface DeadLetterInspectOptions {
  type?: string;
  limit?: number;
  offset?: number;
}

export interface DeadLetterRetryOptions {
  actorId: string;
  /** Report what would be requeued without changing anything. */
  dryRun?: boolean;
}

export interface DeadLetterRetryResult {
  dryRun: boolean;
  /** Jobs requeued, or that would be requeued during a dry run. */
  requeued: string[];
  /** Jobs left alone, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Operator tooling for jobs that exhausted their retries (status `dead`).
 *
 * `inspect` is read-only. `retry` requeues only jobs that are still dead at the
 * moment they are checked, so a job that another operator already requeued or
 * cancelled is skipped rather than touched twice. Every retry is authorized,
 * bounded by batch size, and can be dry-run first.
 */
export class DeadLetterOperator {
  private readonly store: JobStore;
  private readonly canRetry: (actorId: string) => boolean;
  private readonly now: () => Date;

  constructor(options: DeadLetterOperatorOptions) {
    this.store = options.store;
    this.canRetry = options.canRetry;
    this.now = options.now ?? (() => new Date());
  }

  /** Lists dead jobs, newest filters applied by the store. Read-only. */
  async inspect(options: DeadLetterInspectOptions = {}): Promise<{ jobs: Job[]; total: number }> {
    return this.store.list({
      status: 'dead',
      type: options.type,
      limit: options.limit,
      offset: options.offset,
    });
  }

  /**
   * Requeues the given dead jobs with a fresh attempt budget.
   *
   * Throws `DeadLetterForbiddenError` when the actor is not authorized, and a
   * plain `Error` when the batch is empty or larger than
   * `MAX_DEAD_LETTER_RETRY_BATCH`. Per-job problems (not found, not dead,
   * changed concurrently) are reported in `skipped`, not thrown.
   */
  async retry(ids: readonly string[], options: DeadLetterRetryOptions): Promise<DeadLetterRetryResult> {
    if (!options.actorId) {
      throw new DeadLetterForbiddenError('(anonymous)');
    }
    if (!this.canRetry(options.actorId)) {
      throw new DeadLetterForbiddenError(options.actorId);
    }

    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      throw new Error('No job ids given');
    }
    if (unique.length > MAX_DEAD_LETTER_RETRY_BATCH) {
      throw new Error(`Refusing to retry more than ${MAX_DEAD_LETTER_RETRY_BATCH} jobs in one call`);
    }

    const dryRun = options.dryRun === true;
    const result: DeadLetterRetryResult = { dryRun, requeued: [], skipped: [] };

    for (const id of unique) {
      const job = await this.store.get(id);
      if (!job) {
        result.skipped.push({ id, reason: 'not found' });
        continue;
      }
      if (job.status !== 'dead') {
        result.skipped.push({ id, reason: `status is ${job.status}, not dead` });
        continue;
      }
      if (dryRun) {
        result.requeued.push(id);
        continue;
      }
      // requeueDead re-checks the status atomically in the store, so a job
      // changed since the read above comes back null and is skipped.
      const requeued = await this.store.requeueDead(id, this.now());
      if (requeued) {
        result.requeued.push(id);
      } else {
        result.skipped.push({ id, reason: 'changed concurrently' });
      }
    }

    return result;
  }
}
