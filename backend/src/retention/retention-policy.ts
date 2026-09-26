/**
 * Data retention policy (issue #61).
 *
 * Operational data has to be kept long enough to answer "what happened and
 * who saw it", without growing forever. This module is the single place that
 * says how long, and — more importantly — which records are *not* eligible
 * for cleanup no matter how old they are.
 *
 * The policy is split from the mechanism on purpose:
 *
 *   retention-policy.ts  pure classification: what is this data, how long may
 *                        it live, and what protects it. Fully unit-testable.
 *   retention-service.ts the plan/apply cycle that counts candidates and
 *                        performs the delete.
 *
 * Two rules the rest of the system relies on:
 *
 *  1. **Plan before destroy.** `plan()` returns exactly which records are
 *     eligible and which are held back, with counts, and writes nothing. The
 *     job runs the same plan again immediately before deleting, so what an
 *     operator reviewed is what gets removed.
 *
 *  2. **Settlement wins over age.** Anything tied to financial settlement or
 *     an audit trail is never purged by age. That is a deliberate refusal to
 *     be clever: an invoice that was paid is financial record-keeping, and the
 *     local retention window has no authority over it.
 *
 * Code: `backend/src/retention/retention-policy.ts`,
 * `backend/src/retention/retention-service.ts`.
 */

export type DataClass = 'settlement' | 'audit' | 'financial' | 'operational' | 'support';

export interface RetentionRule {
  /** Data set this rule governs, e.g. `invoices`. */
  dataset: string;
  classification: DataClass;
  /** Days after `timestampColumn` that the row becomes eligible. */
  retainDays: number;
  /** Column the window is measured from, documented per dataset. */
  timestampColumn: string;
  /**
   * Why this window, in one line. Documentation requirement: a retention
   * period nobody can justify is a retention period nobody should trust.
   */
  rationale: string;
  /**
   * When false, the rule only ever reports candidates and never deletes.
   * Settlement and audit records are report-only by design.
   */
  purgeable: boolean;
}

/**
 * The policy table. Windows are deliberately conservative and are expressed
 * in days so they are auditable at a glance.
 */
export const RETENTION_RULES: RetentionRule[] = [
  {
    dataset: 'transactions',
    classification: 'settlement',
    retainDays: 365 * 7,
    timestampColumn: 'processed_at',
    rationale:
      'A settled Stellar payment is financial record-keeping. Local retention has no authority to expire it, so this is reported for visibility and never purged.',
    purgeable: false,
  },
  {
    dataset: 'paid_invoices',
    classification: 'financial',
    retainDays: 365 * 7,
    timestampColumn: 'paid_at',
    rationale:
      'An invoice that was paid is an accounting record and is referenced by its settlement. Report-only; see docs/RETENTION.md for the escalation path.',
    purgeable: false,
  },
  {
    dataset: 'audit_events',
    classification: 'audit',
    retainDays: 365 * 2,
    timestampColumn: 'timestamp',
    rationale:
      'Audit events are never purged by this sweep. They live in a bounded in-memory store (MemoryAuditStore, default cap 5000) that already enforces its own cap by FIFO eviction, so an age-based delete would be redundant and would destroy evidence. Listed here so audit retention is visible in one place rather than being an implicit property of a constructor default.',
    purgeable: false,
  },
  {
    dataset: 'payment_events',
    classification: 'support',
    retainDays: 180,
    timestampColumn: 'created_at',
    rationale:
      'Payment event history is what support reads when a payer disputes a payment. Six months matches the practical life of a dispute.',
    purgeable: true,
  },
  {
    dataset: 'cancelled_invoices',
    classification: 'operational',
    retainDays: 180,
    timestampColumn: 'created_at',
    rationale:
      'A cancelled invoice settled nothing and has no settlement reference, so it is the cheapest class to reclaim once it is out of the support window.',
    purgeable: true,
  },
  {
    dataset: 'expired_invoices',
    classification: 'operational',
    retainDays: 90,
    timestampColumn: 'created_at',
    rationale:
      'An expired invoice was never payable. Kept briefly so a seller can see why an invoice lapsed, then reclaimed.',
    purgeable: true,
  },
  {
    dataset: 'completed_jobs',
    classification: 'operational',
    retainDays: 30,
    timestampColumn: 'updated_at',
    rationale:
      'Finished background jobs are operational history, not evidence. Thirty days is enough to investigate a bad week.',
    purgeable: true,
  },
];

/** Why a specific record was held back, so the report can explain itself. */
export type ProtectionReason =
  | 'settled'
  | 'settlement_reference'
  | 'rule_is_report_only'
  | 'not_old_enough'
  | 'not_in_dataset';

export interface ProtectionCounts {
  settled: number;
  settlementReference: number;
  reportOnly: number;
  notOldEnough: number;
}

export const EMPTY_PROTECTION_COUNTS: ProtectionCounts = {
  settled: 0,
  settlementReference: 0,
  reportOnly: 0,
  notOldEnough: 0,
};

export interface RetentionCandidate {
  dataset: string;
  /** Rows eligible for deletion right now. */
  eligible: number;
  /** Rows in the dataset that the policy will not touch, by reason. */
  protected: ProtectionCounts;
  /** Whether this dataset can be deleted at all under the policy. */
  purgeable: boolean;
  cutoff: string;
}

export interface RetentionPlan {
  /** Always true: planning never deletes. */
  dryRun: true;
  evaluatedAt: string;
  /** True when every purgeable dataset is inside its window. */
  clean: boolean;
  candidates: RetentionCandidate[];
  /** Human-readable summary of what apply() would remove. */
  wouldDelete: Record<string, number>;
  /** Datasets deliberately excluded from deletion, with the reason. */
  retained: Array<{ dataset: string; reason: string }>;
}

export function ruleFor(dataset: string): RetentionRule | undefined {
  return RETENTION_RULES.find((r) => r.dataset === dataset);
}

/**
 * Cutoff instant for a rule: rows strictly older than this are eligible.
 * Exported so tests and the docs use the same arithmetic as the service.
 */
export function cutoffFor(rule: RetentionRule, now: Date): Date {
  return new Date(now.getTime() - rule.retainDays * 24 * 60 * 60 * 1000);
}

export function isEligible(rule: RetentionRule, rowTimestamp: Date, now: Date): boolean {
  return rowTimestamp.getTime() < cutoffFor(rule, now).getTime();
}

/** Build a plan from per-dataset counts produced by a store implementation. */
export function buildRetentionPlan(
  counts: Record<string, { eligible: number; protected: ProtectionCounts }>,
  now: Date = new Date()
): RetentionPlan {
  const candidates: RetentionCandidate[] = [];
  const wouldDelete: Record<string, number> = {};
  const retained: Array<{ dataset: string; reason: string }> = [];

  for (const rule of RETENTION_RULES) {
    const count = counts[rule.dataset] ?? { eligible: 0, protected: { ...EMPTY_PROTECTION_COUNTS } };
    const candidate: RetentionCandidate = {
      dataset: rule.dataset,
      eligible: rule.purgeable ? count.eligible : 0,
      protected: count.protected,
      purgeable: rule.purgeable,
      cutoff: cutoffFor(rule, now).toISOString(),
    };
    candidates.push(candidate);

    if (rule.purgeable) {
      wouldDelete[rule.dataset] = count.eligible;
    } else {
      retained.push({ dataset: rule.dataset, reason: rule.rationale });
    }
  }

  const totalEligible = Object.values(wouldDelete).reduce((a, b) => a + b, 0);
  return {
    dryRun: true,
    evaluatedAt: now.toISOString(),
    clean: totalEligible === 0,
    candidates,
    wouldDelete,
    retained,
  };
}

/** One-line summary for a job log or a CLI. */
export function summarisePlan(plan: RetentionPlan): string {
  const total = Object.values(plan.wouldDelete).reduce((a, b) => a + b, 0);
  if (total === 0) return 'Retention: nothing eligible for cleanup.';
  const parts = Object.entries(plan.wouldDelete)
    .filter(([, n]) => n > 0)
    .map(([dataset, n]) => `${n} ${dataset}`);
  return `Retention: ${parts.join(', ')} (${total} rows eligible).`;
}
