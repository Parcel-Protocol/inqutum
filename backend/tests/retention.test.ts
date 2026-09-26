import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRetentionPlan,
  cutoffFor,
  EMPTY_PROTECTION_COUNTS,
  isEligible,
  RETENTION_RULES,
  ruleFor,
  summarisePlan,
} from '../src/retention/retention-policy.ts';
import {
  MemoryRetentionStore,
  RetentionService,
  type RetentionRow,
} from '../src/retention/retention-service.ts';
import {
  RETENTION_SWEEP_INTERVAL_MS,
  RETENTION_SWEEP_JOB,
  registerJobHandlers,
  scheduleRetentionSweep,
} from '../src/jobs/runtime.ts';
import { JobQueue, JobWorker } from '../src/jobs/worker.ts';
import { MemoryJobStore } from '../src/jobs/memory-job-store.ts';

const NOW = new Date('2026-09-26T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe('data retention policy (issue #61)', () => {
  describe('policy table', () => {
    it('classifies every data set and justifies its window', () => {
      assert.ok(RETENTION_RULES.length > 0);
      for (const rule of RETENTION_RULES) {
        assert.ok(rule.dataset.length > 0);
        assert.ok(rule.retainDays > 0, `${rule.dataset} needs a positive window`);
        assert.ok(rule.timestampColumn.length > 0);
        assert.ok(rule.rationale.length > 30, `${rule.dataset} needs a documented justification`);
      }
    });

    it('never purges settlement or financial records at any age', () => {
      const neverPurged = RETENTION_RULES.filter((r) => !r.purgeable).map((r) => r.dataset);
      assert.ok(neverPurged.includes('transactions'), 'settlements must be report-only');
      assert.ok(neverPurged.includes('paid_invoices'), 'paid invoices must be report-only');
      assert.ok(neverPurged.includes('audit_events'), 'audit events must be report-only');
    });

    it('keeps the purgeable datasets strictly short of the protected windows', () => {
      const protectedWindows = RETENTION_RULES.filter((r) => !r.purgeable).map((r) => r.retainDays);
      const shortestProtected = Math.min(...protectedWindows);
      for (const rule of RETENTION_RULES.filter((r) => r.purgeable)) {
        assert.ok(
          rule.retainDays < shortestProtected,
          `${rule.dataset} (${rule.retainDays}d) must expire before the shortest protected window (${shortestProtected}d)`
        );
      }
    });

    it('computes a cutoff from the window', () => {
      const rule = ruleFor('expired_invoices')!;
      assert.equal(cutoffFor(rule, NOW).toISOString(), daysAgo(90).toISOString());
      assert.equal(isEligible(rule, daysAgo(91), NOW), true);
      assert.equal(isEligible(rule, daysAgo(89), NOW), false);
    });
  });

  describe('planning', () => {
    it('is always a dry run and reports zero deletions when clean', () => {
      const plan = buildRetentionPlan({}, NOW);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.clean, true);
      assert.deepEqual(plan.wouldDelete, {
        payment_events: 0,
        cancelled_invoices: 0,
        expired_invoices: 0,
        completed_jobs: 0,
      });
    });

    it('counts purgeable rows and explains the ones it holds back', () => {
      const plan = buildRetentionPlan(
        {
          expired_invoices: {
            eligible: 12,
            protected: { ...EMPTY_PROTECTION_COUNTS, settled: 3, notOldEnough: 40 },
          },
        },
        NOW
      );

      assert.equal(plan.wouldDelete.expired_invoices, 12);
      assert.equal(plan.clean, false);
      const candidate = plan.candidates.find((c) => c.dataset === 'expired_invoices')!;
      assert.equal(candidate.protected.settled, 3);
      assert.equal(candidate.protected.notOldEnough, 40);
    });

    it('never lists a report-only dataset as deletable, however many are past the window', () => {
      const plan = buildRetentionPlan(
        {
          paid_invoices: { eligible: 900, protected: { ...EMPTY_PROTECTION_COUNTS } },
          transactions: { eligible: 400, protected: { ...EMPTY_PROTECTION_COUNTS } },
        },
        NOW
      );

      assert.equal(plan.wouldDelete.paid_invoices, undefined);
      assert.equal(plan.wouldDelete.transactions, undefined);
      assert.ok(plan.retained.some((r) => r.dataset === 'paid_invoices'));
    });

    it('summarises a plan for a job log', () => {
      assert.match(summarisePlan(buildRetentionPlan({}, NOW)), /nothing eligible/);
      const plan = buildRetentionPlan(
        { expired_invoices: { eligible: 3, protected: { ...EMPTY_PROTECTION_COUNTS } } },
        NOW
      );
      assert.match(summarisePlan(plan), /3 expired_invoices/);
    });
  });

  describe('applying', () => {
    function storeWith(rows: Record<string, RetentionRow[]>) {
      return new MemoryRetentionStore(rows);
    }

    it('refuses to delete settled records even when they are old', async () => {
      const store = storeWith({
        expired_invoices: [
          { createdAt: daysAgo(500), status: 'PAID', paidAt: daysAgo(490) },
          { createdAt: daysAgo(500), transactionCount: 1 },
          { createdAt: daysAgo(500), status: 'EXPIRED' },
        ],
      });
      const service = new RetentionService(store);

      const result = await service.apply(NOW);
      assert.equal(result.deleted.expired_invoices, 1, 'only the unsettled record may go');
      assert.equal(store.size('expired_invoices'), 2);
    });

    it('keeps records inside the window', async () => {
      const store = storeWith({
        expired_invoices: [{ createdAt: daysAgo(10), status: 'EXPIRED' }],
      });

      const result = await new RetentionService(store).apply(NOW);
      assert.equal(result.totalDeleted, 0);
      assert.equal(store.size('expired_invoices'), 1);
    });

    it('skips report-only datasets and says why', async () => {
      const result = await new RetentionService(storeWith({})).apply(NOW);

      const skipped = result.skipped.map((s) => s.dataset);
      assert.ok(skipped.includes('transactions'));
      assert.ok(skipped.includes('paid_invoices'));
      assert.ok(result.skipped.every((s) => s.reason.length > 20));
      assert.equal(result.totalDeleted, 0);
    });

    it('honours the per-run batch limit', async () => {
      const store = storeWith({
        expired_invoices: Array.from({ length: 10 }, () => ({
          createdAt: daysAgo(200),
          status: 'EXPIRED',
        })),
      });

      const result = await new RetentionService(store, { batchLimit: 3 }).apply(NOW);
      assert.equal(result.deleted.expired_invoices, 3);
      assert.equal(store.size('expired_invoices'), 7, 'the rest wait for the next sweep');
    });

    it('a plan-then-apply pass touches the same rows the plan reported', async () => {
      const store = storeWith({
        cancelled_invoices: [
          { createdAt: daysAgo(200), status: 'CANCELLED' },
          { createdAt: daysAgo(200), status: 'CANCELLED' },
          { createdAt: daysAgo(200), status: 'CANCELLED', paymentTxHash: 'abc' } as RetentionRow,
        ],
      });
      const service = new RetentionService(store);

      const plan = await service.plan(NOW);
      const result = await service.apply(NOW);
      assert.equal(plan.wouldDelete.cancelled_invoices, result.deleted.cancelled_invoices);
    });
  });

  describe('job integration', () => {
    function harness(retention: RetentionService) {
      const store = new MemoryJobStore();
      const now = () => NOW;
      const worker = registerJobHandlers(new JobWorker({ store, now }), {
        expirePendingInvoices: async () => 0,
        retention,
      });
      return { store, worker, queue: new JobQueue(store, undefined, now) };
    }

    it('never runs a retention job when no store is wired', async () => {
      const store = new MemoryJobStore();
      const now = () => NOW;
      // No `retention` dep, so only the expiry handler is registered.
      const worker = registerJobHandlers(new JobWorker({ store, now }), {
        expirePendingInvoices: async () => 0,
      });
      const queue = new JobQueue(store, undefined, now);
      const { job } = await scheduleRetentionSweep(queue, NOW);

      // The worker only claims job types it has a handler for, so the sweep is
      // left untouched rather than executed against a missing service.
      assert.equal(await worker.runOnce(), null);
      const outcome = (await store.get(job.id))!;
      assert.equal(outcome.status, 'queued');
      assert.equal(outcome.result, null);
    });

    it('reports by default and deletes only when explicitly applied', async () => {
      const memStore = new MemoryRetentionStore({
        expired_invoices: [{ createdAt: daysAgo(200), status: 'EXPIRED' }],
      });
      const { store, worker, queue } = harness(new RetentionService(memStore));

      const { job: reportJob } = await scheduleRetentionSweep(queue, NOW);
      await worker.runOnce();
      const reported = (await store.get(reportJob.id))?.result as {
        applied: boolean;
        wouldDelete: Record<string, number>;
      };
      assert.equal(reported.applied, false);
      assert.equal(reported.wouldDelete.expired_invoices, 1);
      assert.equal(memStore.size('expired_invoices'), 1, 'a report must not delete');

      const { job: applyJob } = await scheduleRetentionSweep(queue, NOW, RETENTION_SWEEP_INTERVAL_MS, true);
      await worker.runOnce();
      const applied = (await store.get(applyJob.id))?.result as { applied: boolean; totalDeleted: number };
      assert.equal(applied.applied, true);
      assert.equal(applied.totalDeleted, 1);
      assert.equal(memStore.size('expired_invoices'), 0);
    });

    it('buckets report and apply runs under different keys', async () => {
      const memStore = new MemoryRetentionStore();
      const { queue } = harness(new RetentionService(memStore));

      const a = await scheduleRetentionSweep(queue, NOW);
      const b = await scheduleRetentionSweep(queue, NOW, RETENTION_SWEEP_INTERVAL_MS, true);
      assert.notEqual(a.job.idempotencyKey, b.job.idempotencyKey);
    });

    it('collapses repeated sweeps in the same bucket', async () => {
      const { queue } = harness(new RetentionService(new MemoryRetentionStore()));
      const a = await scheduleRetentionSweep(queue, NOW);
      const b = await scheduleRetentionSweep(queue, new Date(NOW.getTime() + 1_000));
      assert.equal(a.job.idempotencyKey, b.job.idempotencyKey);
    });

    it('uses its own job type and interval', () => {
      assert.equal(RETENTION_SWEEP_JOB, 'retention.sweep');
      assert.ok(RETENTION_SWEEP_INTERVAL_MS > 0);
    });
  });
});
