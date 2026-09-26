/**
 * Disaster-recovery validation for core domain invariants (issue #62).
 *
 * After a restore, a migration or a failover, a maintainer needs proof that
 * the records which matter are still consistent. This module answers one
 * question per invariant and nothing else: does the data still hold together?
 *
 * Two properties are load-bearing:
 *
 *  1. **Read-only.** Every statement here is a `SELECT`. The runner refuses
 *     any query that is not a SELECT so a future edit cannot quietly turn a
 *     validation run into a data-mutating one. `readOnly` is asserted in the
 *     report and the CLI exits non-zero on failure so it can gate a deploy.
 *
 *  2. **Explainable.** Each invariant carries `remediation`, because a bare
 *     count of broken rows is not actionable during an incident. Severity
 *     distinguishes "this data is corrupt" from "this needs a human look".
 *
 * Code: `backend/src/ops/dr-validation.ts`. CLI: `backend/src/ops/dr-validate-cli.ts`.
 */

export type Severity = 'error' | 'warning';

export interface Invariant {
  /** Stable identifier; safe to use in docs and escalation notes. */
  id: string;
  title: string;
  severity: Severity;
  /** Must be a SELECT. Anything else is refused by the runner. */
  sql: string;
  /** What a non-zero count means, in operational terms. */
  detail: string;
  /** What a maintainer should actually do about it. */
  remediation: string;
}

export interface InvariantResult {
  id: string;
  title: string;
  severity: Severity;
  passed: boolean;
  /** Number of offending rows. 0 means the invariant holds. */
  count: number;
  detail: string;
  remediation: string;
  /** First few offending rows, to make the report actionable. */
  samples: Array<Record<string, unknown>>;
}

export interface DRReport {
  ranAt: string;
  /** Always true. Present so a stored report carries its own guarantee. */
  readOnly: true;
  passed: boolean;
  results: InvariantResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    warnings: number;
  };
}

export class DRValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DRValidationError';
  }
}

export interface DRQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

const INVOICE_COLUMNS = 'id, seller_public_key, amount, status, memo, external_id, expires_at, paid_at, payment_tx_hash';

/**
 * Core restore invariants, ordered roughly from "cheapest and most alarming"
 * to "needs a join". Errors mean the data is inconsistent; warnings mean it is
 * suspicious but self-consistent (usually a workflow that did not finish).
 */
export const DR_INVARIANTS: Invariant[] = [
  {
    id: 'invoices.missing_seller',
    title: 'Every invoice has a seller wallet',
    severity: 'error',
    sql: `SELECT id, seller_public_key
          FROM invoices
          WHERE seller_public_key IS NULL OR seller_public_key = ''`,
    detail: 'Invoices exist with no seller wallet, so they belong to nobody and cannot be listed, paid or exported.',
    remediation:
      'Do not delete. Identify the source system and re-attach the correct seller_public_key; an invoice with no owner is a restore from a partial dump, not a data-entry mistake.',
  },
  {
    id: 'invoices.invalid_amount',
    title: 'Every invoice has a positive amount',
    severity: 'error',
    sql: `SELECT id, amount
          FROM invoices
          WHERE amount IS NULL OR amount <= 0`,
    detail: 'Invoices exist with a zero or negative amount, which the create path rejects, so these came from a bad import or a corrupted restore.',
    remediation:
      'Quarantine these rows and reconcile against the payment that settled them. Never repair an amount in place: the on-chain amount is the source of truth and the invoice must be corrected to match it.',
  },
  {
    id: 'invoices.duplicate_memo',
    title: 'Invoice memos are unique',
    severity: 'error',
    sql: `SELECT memo, COUNT(*) AS copies, MIN(id) AS first_id
          FROM invoices
          WHERE memo IS NOT NULL
          GROUP BY memo
          HAVING COUNT(*) > 1
          ORDER BY copies DESC`,
    detail: 'The same memo appears on more than one invoice. Memos are the payment-matching key, so a duplicate can route a payment to the wrong invoice.',
    remediation:
      'Treat as a payment-routing incident. Work out which invoice is authoritative before any cleanup, and check whether a payment was already matched to the wrong one.',
  },
  {
    id: 'invoices.duplicate_external_id',
    title: 'Import external IDs are unique',
    severity: 'error',
    sql: `SELECT external_id, COUNT(*) AS copies
          FROM invoices
          WHERE external_id IS NOT NULL
          GROUP BY external_id
          HAVING COUNT(*) > 1
          ORDER BY copies DESC`,
    detail: 'The same import key appears on more than one invoice, which breaks the idempotency guarantee in docs/IMPORTS.md.',
    remediation:
      'Decide which invoice legitimately owns the key and clear external_id from the others. Do not merge the invoices; the key is import metadata, not a domain identity.',
  },
  {
    id: 'transactions.orphaned',
    title: 'Every transaction points at an existing invoice',
    severity: 'error',
    sql: `SELECT t.id, t.invoice_id, t.tx_hash
          FROM transactions t
          LEFT JOIN invoices i ON i.id = t.invoice_id
          WHERE t.invoice_id IS NOT NULL AND i.id IS NULL`,
    detail: 'Transactions reference an invoice that does not exist, so payment history has been separated from the invoices it settled.',
    remediation:
      'Usually a partial restore. Restore the missing invoices rather than deleting the transactions: the on-chain settlement is real even if the local record is missing.',
  },
  {
    id: 'payment_events.orphaned',
    title: 'Every payment event points at an existing invoice',
    severity: 'error',
    sql: `SELECT e.id, e.invoice_id, e.event_type
          FROM payment_events e
          LEFT JOIN invoices i ON i.id = e.invoice_id
          WHERE e.invoice_id IS NOT NULL AND i.id IS NULL`,
    detail: 'Payment events reference a missing invoice, so the audit trail of a payment cannot be read back.',
    remediation: 'Restore the missing invoice. Payment events are append-only evidence and should not be deleted to make the check pass.',
  },
  {
    id: 'invoices.paid_without_settlement',
    title: 'Paid invoices carry settlement references',
    severity: 'error',
    sql: `SELECT id, status, payment_tx_hash, paid_at
          FROM invoices
          WHERE status = 'PAID' AND (payment_tx_hash IS NULL OR paid_at IS NULL)`,
    detail: 'Invoices are marked PAID without a transaction hash or a paid timestamp, so the settlement cannot be verified on chain.',
    remediation:
      'Highest-severity case. A PAID invoice with no transaction hash may be a false settlement. Verify each against Horizon before trusting balances, and escalate rather than auto-fixing.',
  },
  {
    id: 'invoices.settled_but_not_paid',
    title: 'Settled invoices are marked PAID',
    severity: 'error',
    sql: `SELECT id, status, payment_tx_hash
          FROM invoices
          WHERE payment_tx_hash IS NOT NULL AND status <> 'PAID'`,
    detail: 'Invoices carry a transaction hash but are not PAID, so revenue totals under-report and the invoice may still be payable a second time.',
    remediation:
      'Check whether the referenced transaction actually settled the full amount. If it did, the status is the thing that is wrong; if it did not, the hash should not be attached.',
  },
  {
    id: 'transactions.duplicate_tx_hash',
    title: 'Transaction hashes are unique',
    severity: 'error',
    sql: `SELECT tx_hash, COUNT(*) AS copies
          FROM transactions
          WHERE tx_hash IS NOT NULL
          GROUP BY tx_hash
          HAVING COUNT(*) > 1`,
    detail: 'One Stellar transaction is recorded as settling more than one invoice, so at least one settlement is misattributed.',
    remediation: 'Reconcile against Horizon. A single transaction settles a single payment, so the extra rows are a restore artifact.',
  },
  {
    id: 'invoices.pending_past_expiry',
    title: 'No invoice is PENDING after its expiry',
    severity: 'warning',
    sql: `SELECT id, status, expires_at
          FROM invoices
          WHERE status = 'PENDING' AND expires_at <= NOW()`,
    detail:
      'Invoices are still PENDING past their expiry. This is normally harmless because reads apply the expiry transition lazily, so it usually means the expiry sweep has not run since the restore.',
    remediation:
      'Run the expiry sweep (job type invoices.expire-pending) rather than editing rows. If it does not clear them, the invoice table is missing its expires_at index.',
  },
  {
    id: 'invoices.paid_after_expiry',
    title: 'No invoice was paid after it expired',
    severity: 'warning',
    sql: `SELECT id, expires_at, paid_at
          FROM invoices
          WHERE paid_at IS NOT NULL AND expires_at IS NOT NULL AND paid_at > expires_at`,
    detail: 'Invoices were paid after their payment window closed, which the verify path is meant to refuse.',
    remediation:
      'Confirm with Horizon whether these payments settled. If they did, the guard was bypassed or disabled during the incident, and that is the finding worth escalating.',
  },
];

/** Guard against a future edit turning a validation query into a write. */
function assertReadOnly(sql: string, id: string): void {
  const normalised = sql.trim().toLowerCase();
  const withoutLeadingParens = normalised.replace(/^\(+/, '');
  if (!withoutLeadingParens.startsWith('select') && !withoutLeadingParens.startsWith('with')) {
    throw new DRValidationError(
      `Invariant "${id}" is not read-only. DR validation only runs SELECT statements; got: ${sql.trim().slice(0, 40)}`
    );
  }
  // A CTE can still contain a data-modifying statement, so reject those too.
  const mutating = /\b(insert|update|delete|drop|truncate|alter|create)\b/;
  const withoutStrings = sql.replace(/'[^']*'/g, "''");
  if (mutating.test(withoutStrings.toLowerCase())) {
    throw new DRValidationError(
      `Invariant "${id}" contains a data-modifying keyword. DR validation must not write.`
    );
  }
}

export interface RunValidationOptions {
  /** Cap on sample rows kept per invariant, to keep a report readable. */
  sampleLimit?: number;
  /** Restrict to a subset, e.g. to re-check one area after a repair. */
  only?: string[];
  /** Invariant catalogue; overridable for tests. */
  invariants?: Invariant[];
}

export const DEFAULT_SAMPLE_LIMIT = 5;

/**
 * Run every invariant and return a report. Performs no writes.
 */
export async function validateDisasterRecovery(
  db: DRQueryable,
  options: RunValidationOptions = {}
): Promise<DRReport> {
  const catalogue = options.invariants ?? DR_INVARIANTS;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const only = options.only?.length ? new Set(options.only) : null;

  const selected = only ? catalogue.filter((i) => only.has(i.id)) : catalogue;
  if (only && selected.length === 0) {
    throw new DRValidationError(
      `No invariants matched ${JSON.stringify(options.only)}. Known ids: ${catalogue.map((i) => i.id).join(', ')}`
    );
  }

  const results: InvariantResult[] = [];
  for (const invariant of selected) {
    assertReadOnly(invariant.sql, invariant.id);
    const result = await db.query(invariant.sql);
    const rows = result.rows ?? [];
    results.push({
      id: invariant.id,
      title: invariant.title,
      severity: invariant.severity,
      passed: rows.length === 0,
      count: rows.length,
      detail: invariant.detail,
      remediation: invariant.remediation,
      samples: rows.slice(0, sampleLimit),
    });
  }

  const failed = results.filter((r) => !r.passed);
  return {
    ranAt: new Date().toISOString(),
    readOnly: true,
    passed: failed.length === 0,
    results,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      errors: failed.filter((r) => r.severity === 'error').length,
      warnings: failed.filter((r) => r.severity === 'warning').length,
    },
  };
}

/** Render a report for a terminal. Intentionally plain text, no colour codes. */
export function formatDRReport(report: DRReport): string {
  const lines: string[] = [];
  lines.push('Disaster-recovery validation');
  lines.push(`  ran at:  ${report.ranAt}`);
  lines.push(`  read-only: ${report.readOnly}`);
  lines.push('');
  lines.push(
    `  ${report.summary.passed}/${report.summary.total} invariants hold ` +
      `(${report.summary.errors} error, ${report.summary.warnings} warning)`
  );
  lines.push('');

  for (const result of report.results) {
    const mark = result.passed ? 'PASS' : result.severity === 'error' ? 'FAIL' : 'WARN';
    lines.push(`[${mark}] ${result.id} — ${result.title}`);
    if (!result.passed) {
      lines.push(`       ${result.count} offending row(s). ${result.detail}`);
      for (const sample of result.samples) {
        lines.push(`       - ${JSON.stringify(sample)}`);
      }
      lines.push(`       Fix: ${result.remediation}`);
    }
  }

  lines.push('');
  lines.push(
    report.passed
      ? '  Result: PASS. No restore defects detected.'
      : '  Result: FAIL. See remediation above; escalate errors before serving traffic.'
  );
  return lines.join('\n');
}
