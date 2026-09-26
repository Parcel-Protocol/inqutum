/**
 * Retention plan/apply cycle (issue #61).
 *
 * `plan()` counts and explains; `apply()` deletes. Both go through the same
 * store, and `apply()` recomputes rather than trusting a stored plan, so a
 * destructive run can never act on a stale count.
 *
 * The store interface is deliberately shaped around "tell me what would happen"
 * rather than "delete where older than X", because the protection rules need
 * to be evaluated in one place. Implementations must be read-only for
 * `countEligible`.
 */
import {
  buildRetentionPlan,
  EMPTY_PROTECTION_COUNTS,
  RETENTION_RULES,
  ruleFor,
  summarisePlan,
  type ProtectionCounts,
  type RetentionPlan,
} from './retention-policy';

export interface RetentionStore {
  /**
   * Rows in `dataset` older than the rule's cutoff, split by why anything was
   * held back. Must not write.
   */
  countEligible(
    dataset: string,
    cutoff: Date
  ): Promise<{ eligible: number; protected: ProtectionCounts }>;

  /**
   * Delete up to `limit` eligible rows and return how many were removed.
   * Called only for purgeable datasets.
   */
  deleteEligible(dataset: string, cutoff: Date, limit: number): Promise<number>;
}

export class RetentionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionStoreError';
  }
}

export interface RetentionApplyResult {
  dryRun: false;
  evaluatedAt: string;
  /** Rows actually removed, per dataset. */
  deleted: Record<string, number>;
  /** Datasets skipped because the policy forbids purging them. */
  skipped: Array<{ dataset: string; reason: string }>;
  totalDeleted: number;
}

export interface RetentionServiceOptions {
  /** Safety cap per dataset per run, so one bad plan cannot nuke a table. */
  batchLimit?: number;
  rules?: typeof RETENTION_RULES;
}

export const DEFAULT_BATCH_LIMIT = 1000;

export class RetentionService {
  private readonly batchLimit: number;
  private readonly rules;

  constructor(
    private readonly store: RetentionStore,
    options: RetentionServiceOptions = {}
  ) {
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.rules = options.rules ?? RETENTION_RULES;
  }

  /** Count and explain. Performs no writes. */
  async plan(now: Date = new Date()): Promise<RetentionPlan> {
    const counts: Record<string, { eligible: number; protected: ProtectionCounts }> = {};

    for (const rule of this.rules) {
      const cutoff = new Date(now.getTime() - rule.retainDays * 24 * 60 * 60 * 1000);
      const result = await this.store.countEligible(rule.dataset, cutoff);
      counts[rule.dataset] = {
        // A report-only dataset may report how many rows are past the window,
        // but none of them are ever deletable.
        eligible: result.eligible,
        protected: { ...EMPTY_PROTECTION_COUNTS, ...result.protected },
      };
    }

    return buildRetentionPlan(counts, now);
  }

  /**
   * Delete eligible rows.
   *
   * Recomputes eligibility immediately before deleting, so the destructive
   * set always matches current data rather than a previously reviewed plan.
   * Report-only datasets (settlement, financial) are refused here as a
   * defence in depth: even a misconfigured rule cannot purge them.
   */
  async apply(now: Date = new Date()): Promise<RetentionApplyResult> {
    const deleted: Record<string, number> = {};
    const skipped: Array<{ dataset: string; reason: string }> = [];

    for (const rule of this.rules) {
      if (!rule.purgeable) {
        skipped.push({ dataset: rule.dataset, reason: rule.rationale });
        continue;
      }

      const cutoff = new Date(now.getTime() - rule.retainDays * 24 * 60 * 60 * 1000);
      const result = await this.store.countEligible(rule.dataset, cutoff);
      if (result.eligible === 0) continue;

      const removed = await this.store.deleteEligible(rule.dataset, cutoff, this.batchLimit);
      if (removed > 0) deleted[rule.dataset] = removed;
    }

    return {
      dryRun: false,
      evaluatedAt: now.toISOString(),
      deleted,
      skipped,
      totalDeleted: Object.values(deleted).reduce((a, b) => a + b, 0),
    };
  }
}

/** In-memory store over plain arrays. Used by tests and the MVP server. */
export interface RetentionRow {
  createdAt: Date;
  paidAt?: Date;
  status?: string;
  settledAt?: Date;
  transactionCount?: number;
}

export class MemoryRetentionStore implements RetentionStore {
  constructor(private readonly rows: Record<string, RetentionRow[]> = {}) {}

  async countEligible(dataset: string, cutoff: Date) {
    const rule = ruleFor(dataset);
    if (!rule) return { eligible: 0, protected: { ...EMPTY_PROTECTION_COUNTS } };

    const rows = this.rows[dataset] ?? [];
    const protectedCounts = { ...EMPTY_PROTECTION_COUNTS };
    let eligible = 0;

    for (const row of rows) {
      // Settlement-linked records are protected regardless of age.
      if (row.status === 'PAID' || (row.transactionCount ?? 0) > 0 || row.paidAt) {
        protectedCounts.settled += 1;
        continue;
      }
      const timestamp = rule.timestampColumn === 'paid_at' ? row.paidAt : row.createdAt;
      if (!timestamp) {
        protectedCounts.notOldEnough += 1;
        continue;
      }
      if (timestamp.getTime() < cutoff.getTime()) eligible += 1;
      else protectedCounts.notOldEnough += 1;
    }

    if (!rule.purgeable) protectedCounts.reportOnly += eligible;
    return { eligible, protected: protectedCounts };
  }

  async deleteEligible(dataset: string, cutoff: Date, limit: number): Promise<number> {
    const rule = ruleFor(dataset);
    if (!rule) throw new RetentionStoreError(`Unknown dataset "${dataset}"`);

    const rows = this.rows[dataset] ?? [];
    const doomed: number[] = [];
    for (const [index, row] of rows.entries()) {
      if (row.status === 'PAID' || (row.transactionCount ?? 0) > 0 || row.paidAt) continue;
      const timestamp = rule.timestampColumn === 'paid_at' ? row.paidAt : row.createdAt;
      if (timestamp && timestamp.getTime() < cutoff.getTime()) doomed.push(index);
      if (doomed.length >= limit) break;
    }

    for (const index of doomed.reverse()) rows.splice(index, 1);
    return doomed.length;
  }

  size(dataset: string): number {
    return (this.rows[dataset] ?? []).length;
  }
}

export { summarisePlan };
