import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  SyntheticJourneyMonitor,
  UnauthorizedSyntheticRunError,
  formatSyntheticJourneyReport,
} from '../src/ops/synthetic-journey-monitor';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { createOpsRouter } from '../src/routes/ops.routes';

describe('Synthetic journey monitor for critical end-to-end workflow (Issue #264)', () => {
  it('runs complete happy path journey and records per-step and total latency', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney();

    assert.equal(report.success, true);
    assert.ok(report.totalLatencyMs >= 0);
    assert.equal(report.steps.length, 5);

    // Verify all 5 steps passed in sequence
    const expectedSteps = [
      'CREATE_INVOICE',
      'INSPECT_PAYMENT_DETAILS',
      'VERIFY_STELLAR_PAYMENT',
      'CONFIRM_SETTLEMENT',
      'DISPATCH_EVENT_AND_RECEIPT',
    ];

    for (let i = 0; i < expectedSteps.length; i++) {
      assert.equal(report.steps[i].step, expectedSteps[i]);
      assert.equal(report.steps[i].status, 'PASS');
      assert.ok(report.steps[i].latencyMs >= 0);
    }

    const formatted = formatSyntheticJourneyReport(report);
    assert.match(formatted, /SUCCESS/);
    assert.match(formatted, /Total Latency:/);
  });

  it('accurately blames STORAGE_LAYER when invoice creation fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'CREATE_INVOICE',
      injectedFailureMessage: 'Database connection timeout',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CREATE_INVOICE');
    assert.equal(report.blamedDependency, 'STORAGE_LAYER');
    assert.match(report.rootCause || '', /Database connection timeout/);
    assert.match(report.remediation || '', /connection pool/);
  });

  it('accurately blames API_LAYER when payment envelope retrieval fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'INSPECT_PAYMENT_DETAILS',
      injectedFailureMessage: 'Read replica stale lag',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'INSPECT_PAYMENT_DETAILS');
    assert.equal(report.blamedDependency, 'API_LAYER');
    assert.match(report.remediation || '', /HTTP API routes/);
  });

  it('accurately blames STELLAR_HORIZON when on-chain payment matching fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'VERIFY_STELLAR_PAYMENT',
      injectedFailureMessage: 'Horizon 504 Gateway Timeout',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'VERIFY_STELLAR_PAYMENT');
    assert.equal(report.blamedDependency, 'STELLAR_HORIZON');
    assert.match(report.remediation || '', /Horizon RPC connectivity/);
  });

  it('accurately blames SETTLEMENT_ENGINE when state transition to PAID fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'CONFIRM_SETTLEMENT',
      injectedFailureMessage: 'Optimistic lock conflict during settlement',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CONFIRM_SETTLEMENT');
    assert.equal(report.blamedDependency, 'SETTLEMENT_ENGINE');
    assert.match(report.remediation || '', /optimistic lock versioning/);
  });

  it('accurately blames EXPORT_ENGINE when receipt proof generation fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'DISPATCH_EVENT_AND_RECEIPT',
      injectedFailureMessage: 'Export schema serialization failure',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'DISPATCH_EVENT_AND_RECEIPT');
    assert.equal(report.blamedDependency, 'EXPORT_ENGINE');
    assert.match(report.remediation || '', /export pipeline schemas/);
  });

  it('recovers from transient failures within maxRetries and records retriedSteps and attempts', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage, maxRetries: 2, retryDelayMs: 1 });

    const report = await monitor.runJourney({
      injectedTransientFailures: { VERIFY_STELLAR_PAYMENT: 2 },
      injectedFailureMessage: 'Transient Horizon 504',
    });

    assert.equal(report.success, true);
    assert.deepEqual(report.retriedSteps, ['VERIFY_STELLAR_PAYMENT']);
    const verifyStep = report.steps.find((s) => s.step === 'VERIFY_STELLAR_PAYMENT');
    assert.equal(verifyStep?.status, 'PASS');
    assert.equal(verifyStep?.attempts, 3);
    assert.equal(report.steps.find((s) => s.step === 'CREATE_INVOICE')?.attempts, 1);
  });

  it('fails with dependency blame when transient failures exhaust maxRetries', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage, maxRetries: 1, retryDelayMs: 0 });

    const report = await monitor.runJourney({
      injectedTransientFailures: { CONFIRM_SETTLEMENT: 3 },
      injectedFailureMessage: 'Persistent optimistic lock conflict',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CONFIRM_SETTLEMENT');
    assert.equal(report.blamedDependency, 'SETTLEMENT_ENGINE');
    assert.deepEqual(report.retriedSteps, ['CONFIRM_SETTLEMENT']);
    assert.equal(report.steps.find((s) => s.step === 'CONFIRM_SETTLEMENT')?.attempts, 2);
  });

  it('cleans up synthetic invoices on failure and ignores cleanup errors', async () => {
    const storage = new MemoryInvoiceStorage();
    let deletedId: string | null = null;
    (storage as any).deleteInvoice = async (id: string) => {
      deletedId = id;
      throw new Error('Cleanup failure should not mask report');
    };

    const monitor = new SyntheticJourneyMonitor({ storage });
    const report = await monitor.runJourney({
      injectedFailureStep: 'CONFIRM_SETTLEMENT',
    });

    assert.equal(report.success, false);
    assert.ok(deletedId, 'deleteInvoice should have been called for the synthetic invoice');
  });

  it('enforces authorization when requireAuthorization is enabled', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage, requireAuthorization: true });

    await assert.rejects(
      () => monitor.runJourney({ actor: { role: 'viewer', authorized: false } }),
      (err: unknown) => err instanceof UnauthorizedSyntheticRunError && err.code === 'UNAUTHORIZED_SYNTHETIC_RUN'
    );

    const report = await monitor.runJourney({ actor: { role: 'maintainer' } });
    assert.equal(report.success, true);
  });

  it('protects POST /ops/synthetic-journey/run with admin authorization', async () => {
    const prevToken = process.env.JOBS_ADMIN_TOKEN;
    process.env.JOBS_ADMIN_TOKEN = 'test-synth-admin-token';
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: new MemoryInvoiceStorage(), jobStore: new MemoryJobStore() }));

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}/api/ops/synthetic-journey/run`;

      const unauthRes = await fetch(base, { method: 'POST' });
      assert.equal(unauthRes.status, 401);

      const wrongRes = await fetch(base, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(wrongRes.status, 401);

      const okRes = await fetch(base, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-synth-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ maxRetries: 1, retryDelayMs: 0 }),
      });
      assert.equal(okRes.status, 200);
      const body = await okRes.json() as any;
      assert.equal(body.success, true);
      assert.equal(body.data.steps.length, 5);
    } finally {
      server.close();
      if (prevToken === undefined) {
        delete process.env.JOBS_ADMIN_TOKEN;
      } else {
        process.env.JOBS_ADMIN_TOKEN = prevToken;
      }
    }
  });
});
