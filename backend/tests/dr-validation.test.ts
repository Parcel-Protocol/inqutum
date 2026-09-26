import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DR_INVARIANTS,
  DRValidationError,
  formatDRReport,
  validateDisasterRecovery,
  type DRQueryable,
} from '../src/ops/dr-validation.ts';

/** Maps invariant id -> rows, matched by the table/column names in its SQL. */
function dbWith(overrides: Record<string, any[]>): DRQueryable {
  return {
    async query(sql: string) {
      for (const [id, rows] of Object.entries(overrides)) {
        if (sql === DR_INVARIANTS.find((i) => i.id === id)?.sql) return { rows };
      }
      return { rows: [] };
    },
  };
}

describe('disaster-recovery validation (issue #62)', () => {
  describe('invariants', () => {
    it('covers missing, orphaned, duplicated and inconsistent records', () => {
      const ids = DR_INVARIANTS.map((i) => i.id);
      assert.ok(ids.some((id) => id.includes('missing_seller')), 'missing records');
      assert.ok(ids.some((id) => id.includes('orphaned')), 'orphaned records');
      assert.ok(ids.some((id) => id.includes('duplicate')), 'duplicated records');
      assert.ok(ids.some((id) => id.includes('settled') || id.includes('paid')), 'inconsistent records');
    });

    it('gives every invariant a unique id, a remediation and a severity', () => {
      const ids = new Set(DR_INVARIANTS.map((i) => i.id));
      assert.equal(ids.size, DR_INVARIANTS.length, 'ids must be unique');
      for (const invariant of DR_INVARIANTS) {
        assert.ok(invariant.remediation.length > 20, `${invariant.id} needs actionable remediation`);
        assert.ok(['error', 'warning'].includes(invariant.severity));
      }
    });
  });

  describe('read-only guarantee', () => {
    it('marks the report read-only', async () => {
      const report = await validateDisasterRecovery(dbWith({}));
      assert.equal(report.readOnly, true);
    });

    it('refuses an invariant that writes', async () => {
      const writeInvariant = {
        id: 'bad.write',
        title: 'deletes rows',
        severity: 'error' as const,
        sql: "DELETE FROM invoices WHERE status = 'PENDING'",
        detail: 'nope',
        remediation: 'nope',
      };

      await assert.rejects(
        () => validateDisasterRecovery(dbWith({}), { invariants: [writeInvariant] }),
        DRValidationError
      );
    });

    it('refuses a data-modifying CTE', async () => {
      const cteInvariant = {
        id: 'bad.cte',
        title: 'deletes via CTE',
        severity: 'error' as const,
        sql: "WITH gone AS (DELETE FROM invoices RETURNING id) SELECT * FROM gone",
        detail: 'nope',
        remediation: 'nope',
      };

      await assert.rejects(
        () => validateDisasterRecovery(dbWith({}), { invariants: [cteInvariant] }),
        /data-modifying keyword/
      );
    });

    it('issues no statement that is not a SELECT', async () => {
      const seen: string[] = [];
      const db: DRQueryable = {
        async query(sql: string) {
          seen.push(sql.trim().toLowerCase());
          return { rows: [] };
        },
      };

      await validateDisasterRecovery(db);
      assert.equal(seen.length, DR_INVARIANTS.length);
      for (const sql of seen) {
        assert.ok(sql.startsWith('select') || sql.startsWith('with'), sql.slice(0, 30));
      }
    });
  });

  describe('reporting', () => {
    it('passes on clean data', async () => {
      const report = await validateDisasterRecovery(dbWith({}));

      assert.equal(report.passed, true);
      assert.equal(report.summary.failed, 0);
      assert.equal(report.summary.passed, DR_INVARIANTS.length);
    });

    it('fails and counts an error-severity invariant', async () => {
      const report = await validateDisasterRecovery(
        dbWith({
          'invoices.paid_without_settlement': [{ id: 'a', status: 'PAID', payment_tx_hash: null, paid_at: null }],
        })
      );

      assert.equal(report.passed, false);
      assert.equal(report.summary.errors, 1);
      const failed = report.results.find((r) => r.id === 'invoices.paid_without_settlement')!;
      assert.equal(failed.passed, false);
      assert.equal(failed.count, 1);
      assert.equal(failed.samples[0].id, 'a');
    });

    it('separates warnings from errors', async () => {
      const report = await validateDisasterRecovery(
        dbWith({
          'invoices.pending_past_expiry': [{ id: 'p', status: 'PENDING' }],
          'invoices.missing_seller': [{ id: 's' }],
        })
      );

      assert.equal(report.summary.errors, 1);
      assert.equal(report.summary.warnings, 1);
    });

    it('caps samples but still reports the true count', async () => {
      const rows = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}` }));
      const report = await validateDisasterRecovery(
        dbWith({ 'invoices.invalid_amount': rows }),
        { sampleLimit: 3 }
      );

      const failed = report.results.find((r) => r.id === 'invoices.invalid_amount')!;
      assert.equal(failed.count, 9);
      assert.equal(failed.samples.length, 3);
    });

    it('restricts to the requested invariants', async () => {
      const report = await validateDisasterRecovery(dbWith({}), { only: ['invoices.duplicate_memo'] });

      assert.equal(report.results.length, 1);
      assert.equal(report.results[0].id, 'invoices.duplicate_memo');
    });

    it('fails loudly on an unknown invariant id', async () => {
      await assert.rejects(
        () => validateDisasterRecovery(dbWith({}), { only: ['nope'] }),
        /No invariants matched/
      );
    });
  });

  describe('operator output', () => {
    it('marks passing and failing invariants distinctly', () => {
      const text = formatDRReport({
        ranAt: '2026-09-26T00:00:00.000Z',
        readOnly: true,
        passed: false,
        summary: { total: 2, passed: 1, failed: 1, errors: 1, warnings: 0 },
        results: [
          {
            id: 'invoices.duplicate_memo',
            title: 'Invoice memos are unique',
            severity: 'error',
            passed: false,
            count: 1,
            detail: 'a duplicate memo exists',
            remediation: 'reconcile against Horizon',
            samples: [{ memo: 'dup' }],
          },
          {
            id: 'invoices.invalid_amount',
            title: 'Every invoice has a positive amount',
            severity: 'error',
            passed: true,
            count: 0,
            detail: '',
            remediation: '',
            samples: [],
          },
        ],
      });

      assert.match(text, /\[FAIL\] invoices\.duplicate_memo/);
      assert.match(text, /\[PASS\] invoices\.invalid_amount/);
      assert.match(text, /reconcile against Horizon/);
      assert.match(text, /Result: FAIL/);
      assert.match(text, /read-only: true/);
    });

    it('says PASS with no remediation when clean', () => {
      const report = { ranAt: 'now', readOnly: true as const, passed: true, summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 }, results: [] };
      assert.match(formatDRReport(report), /Result: PASS/);
    });
  });
});
