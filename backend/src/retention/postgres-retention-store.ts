/**
 * Postgres implementation of the retention store (issue #61).
 *
 * Protection is enforced in SQL rather than in application code so the "never
 * purge anything tied to settlement" guarantee holds even if a caller reaches
 * `deleteEligible` with a hand-rolled cutoff. Every statement is bounded by
 * the batch limit, so a sweep cannot hold a long lock on a large table.
 */
import type { Pool } from 'pg';
import { RetentionStoreError, type RetentionStore } from './retention-service';
import { ruleFor, RETENTION_RULES, type ProtectionCounts, EMPTY_PROTECTION_COUNTS } from './retention-policy';

interface CountableRow {
  total: string;
  settled: string;
  in_window: string;
}

export class PostgresRetentionStore implements RetentionStore {
  constructor(private readonly pool: Pool) {}

  async countEligible(dataset: string, cutoff: Date) {
    const rule = ruleFor(dataset);
    if (!rule) return { eligible: 0, protected: { ...EMPTY_PROTECTION_COUNTS } };

    const sql = COUNT_SQL[dataset];
    if (!sql) {
      // A report-only dataset with no table is expected: audit events are held
      // in a bounded in-memory store, so there is nothing here to count.
      if (!rule.purgeable) return { eligible: 0, protected: { ...EMPTY_PROTECTION_COUNTS } };
      throw new RetentionStoreError(`No retention count query for dataset "${dataset}"`);
    }

    const result = await this.pool.query(sql, [cutoff]);
    const row = (result.rows[0] ?? {}) as CountableRow;
    const total = Number(row.total ?? 0);
    const settled = Number(row.settled ?? 0);
    const inWindow = Number(row.in_window ?? 0);

    const protectedCounts: ProtectionCounts = {
      ...EMPTY_PROTECTION_COUNTS,
      settled,
      // Past the cutoff, but too young to reclaim.
      notOldEnough: Math.max(0, total - settled - inWindow),
    };
    if (!rule.purgeable) protectedCounts.reportOnly += inWindow;

    return { eligible: inWindow, protected: protectedCounts };
  }

  async deleteEligible(dataset: string, cutoff: Date, limit: number): Promise<number> {
    const rule = ruleFor(dataset);
    if (!rule) throw new RetentionStoreError(`Unknown dataset "${dataset}"`);
    if (!rule.purgeable) {
      throw new RetentionStoreError(
        `Dataset "${dataset}" is report-only under the retention policy and must not be deleted.`
      );
    }

    const sql = DELETE_SQL[dataset];
    if (!sql) throw new RetentionStoreError(`No retention delete query for dataset "${dataset}"`);

    // The settlement guards are repeated here on purpose: this is the last line
    // of defence before data is destroyed.
    const result = await this.pool.query(sql, [cutoff, limit]);
    return result.rowCount ?? 0;
  }

  /** Datasets this store can act on, in policy order. */
  static get datasets(): string[] {
    return RETENTION_RULES.map((r) => r.dataset);
  }
}

const COUNT_SQL: Record<string, string | undefined> = {
  // A settled invoice is protected at any age, and no settlement is ever purged.
  paid_invoices: `
    SELECT COUNT(*)::text AS total,
           COUNT(*)::text AS settled,
           0::text AS in_window
      FROM invoices
     WHERE status = 'PAID'`,

  transactions: `
    SELECT COUNT(*)::text AS total,
           COUNT(*)::text AS settled,
           0::text AS in_window
      FROM transactions`,

  cancelled_invoices: `
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE payment_tx_hash IS NOT NULL)::text AS settled,
           COUNT(*) FILTER (
             WHERE payment_tx_hash IS NULL
               AND created_at < $1
           )::text AS in_window
      FROM invoices
     WHERE status IN ('CANCELLED', 'VOIDED')`,

  expired_invoices: `
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE payment_tx_hash IS NOT NULL)::text AS settled,
           COUNT(*) FILTER (
             WHERE payment_tx_hash IS NULL
               AND created_at < $1
           )::text AS in_window
      FROM invoices
     WHERE status = 'EXPIRED'`,

  payment_events: `
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE invoice_id IN (SELECT id FROM invoices WHERE payment_tx_hash IS NOT NULL))::text AS settled,
           COUNT(*) FILTER (
             WHERE created_at < $1
               AND (invoice_id IS NULL OR invoice_id NOT IN (
                     SELECT id FROM invoices WHERE payment_tx_hash IS NOT NULL
               ))
           )::text AS in_window
      FROM payment_events`,

  audit_events: undefined,

  completed_jobs: `
    SELECT COUNT(*)::text AS total,
           0::text AS settled,
           COUNT(*) FILTER (
             WHERE status IN ('completed', 'dead')
               AND updated_at < $1
           )::text AS in_window
      FROM jobs`,
};

const DELETE_SQL: Record<string, string | undefined> = {
  cancelled_invoices: `
    DELETE FROM invoices
     WHERE id IN (
       SELECT id FROM invoices
        WHERE status IN ('CANCELLED', 'VOIDED')
          AND payment_tx_hash IS NULL
          AND created_at < $1
        ORDER BY created_at
        LIMIT $2
     )`,

  expired_invoices: `
    DELETE FROM invoices
     WHERE id IN (
       SELECT id FROM invoices
        WHERE status = 'EXPIRED'
          AND payment_tx_hash IS NULL
          AND created_at < $1
        ORDER BY created_at
        LIMIT $2
     )`,

  payment_events: `
    DELETE FROM payment_events
     WHERE id IN (
       SELECT e.id FROM payment_events e
        WHERE e.created_at < $1
          AND NOT EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.id = e.invoice_id AND i.payment_tx_hash IS NOT NULL
          )
        ORDER BY e.created_at
        LIMIT $2
     )`,

  completed_jobs: `
    DELETE FROM jobs
     WHERE id IN (
       SELECT id FROM jobs
        WHERE status IN ('completed', 'dead')
          AND updated_at < $1
        ORDER BY updated_at
        LIMIT $2
     )`,
};
