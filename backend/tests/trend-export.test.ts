import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import {
  TREND_EXPORT_SCHEMA_ID,
  TREND_EXPORT_SCHEMA_VERSION,
  TREND_EXPORT_NUMERIC_VERSION,
  TrendExportPermissionError,
  TrendExportValidationError,
  generateHistoricalTrendExport,
  floorToWindowStart,
  advanceWindow,
  anonymizeSellerCohort,
} from '../src/exports/trend-export';
import type { StoredInvoice } from '../src/storage/invoice-storage';
import type { StructuredLogEntry } from '../src/observability/telemetry';
import type { Job } from '../src/jobs/job-types';
import { createOpsRouter } from '../src/routes/ops.routes';

const SELLER_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SELLER_B = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const USDC_ISSUER = 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const MAINTAINER = { id: 'maint-1', role: 'maintainer' as const };

function makeInvoice(id: string, overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id,
    sellerPublicKey: SELLER_A,
    sellerName: 'Private Seller Name',
    sellerEmail: 'seller-private@example.com',
    customerName: 'Alice Customer',
    customerEmail: 'alice-pii@example.com',
    payerName: 'Alice Payer',
    payerEmail: 'alice-payer@example.com',
    amount: 100,
    assetCode: 'XLM',
    memo: `INV-${id}`,
    description: 'Confidential consulting invoice',
    status: 'PAID',
    createdAt: new Date('2026-10-15T10:00:00.000Z'),
    paidAt: new Date('2026-10-15T10:05:00.000Z'),
    expiresAt: new Date('2026-10-22T10:00:00.000Z'),
    paymentTxHash: 'a'.repeat(64),
    ...overrides,
  };
}

function makeOp(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    timestamp: '2026-10-15T10:01:00.000Z',
    level: 'info',
    operation: 'invoice.create',
    actor_type: 'seller',
    result: 'success',
    latency_ms: 50,
    correlation_id: 'corr-1',
    ...overrides,
  };
}

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    type: 'payment.verify',
    payload: { version: 1, data: {} },
    status: 'succeeded',
    attempts: 1,
    retryPolicy: { maxAttempts: 5, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
    runAt: '2026-10-15T10:02:00.000Z',
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: null,
    correlationId: 'corr-job',
    errors: [],
    result: null,
    createdAt: '2026-10-15T10:02:00.000Z',
    updatedAt: '2026-10-15T10:02:05.000Z',
    completedAt: '2026-10-15T10:02:05.000Z',
    ...overrides,
  };
}

describe('Historical Trend Export for Operational and Financial Metrics', () => {
  it('includes schema version and generation metadata and matches source fixture aggregations', () => {
    const invoices: StoredInvoice[] = [
      makeInvoice('inv-1', {
        amount: 125.5,
        assetCode: 'XLM',
        status: 'PAID',
        createdAt: new Date('2026-10-15T08:00:00.000Z'),
        paidAt: new Date('2026-10-15T08:01:00.000Z'), // 60,000 ms
      }),
      makeInvoice('inv-2', {
        amount: 74.5,
        assetCode: 'XLM',
        status: 'PENDING',
        createdAt: new Date('2026-10-15T14:00:00.000Z'),
        paidAt: undefined,
      }),
      makeInvoice('inv-3', {
        sellerPublicKey: SELLER_B,
        amount: 250.1234567,
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        status: 'PAID',
        createdAt: new Date('2026-10-16T09:00:00.000Z'),
        paidAt: new Date('2026-10-16T09:02:00.000Z'), // 120,000 ms
      }),
      makeInvoice('inv-4', {
        sellerPublicKey: SELLER_B,
        amount: 50,
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        status: 'EXPIRED',
        createdAt: new Date('2026-10-16T11:00:00.000Z'),
        paidAt: undefined,
      }),
    ];

    const operations: StructuredLogEntry[] = [
      makeOp({ timestamp: '2026-10-15T08:00:10.000Z', latency_ms: 40, result: 'success' }),
      makeOp({
        timestamp: '2026-10-15T09:00:00.000Z',
        operation: 'payment.verify',
        latency_ms: 3200, // > 2500ms SLA threshold -> SLA breach
        result: 'failure',
        error_code: 'HORIZON_UNAVAILABLE',
      }),
      makeOp({ timestamp: '2026-10-16T09:01:00.000Z', latency_ms: 80, result: 'success' }),
    ];

    const jobs: Job[] = [
      makeJob('job-1', { createdAt: '2026-10-15T08:05:00.000Z', status: 'succeeded', attempts: 2 }),
      makeJob('job-2', { createdAt: '2026-10-16T10:00:00.000Z', status: 'dead', attempts: 5 }),
    ];

    const artifact = generateHistoricalTrendExport(
      {
        actor: MAINTAINER,
        granularity: 'day',
        format: 'json',
        dimensions: ['asset', 'status', 'sellerCohort'],
      },
      { invoices, operations, jobs },
      NOW
    );

    // Schema & metadata verification
    assert.equal(artifact.meta.schema, TREND_EXPORT_SCHEMA_ID);
    assert.equal(artifact.meta.schemaVersion, TREND_EXPORT_SCHEMA_VERSION);
    assert.equal(artifact.meta.version, TREND_EXPORT_NUMERIC_VERSION);
    assert.equal(artifact.meta.generatedAt, NOW.toISOString());
    assert.equal(artifact.meta.granularity, 'day');
    assert.equal(artifact.meta.truncated, false);
    assert.deepEqual(artifact.meta.sourceCounts, {
      invoicesEvaluated: 4,
      operationsEvaluated: 3,
      jobsEvaluated: 2,
    });
    assert.equal(artifact.meta.bucketCount, 2);

    // Totals match source fixtures exactly
    assert.equal(artifact.totals.financial.invoicesCreated, 4);
    assert.equal(artifact.totals.financial.invoicesPaid, 2);
    assert.equal(artifact.totals.financial.invoicesPending, 1);
    assert.equal(artifact.totals.financial.invoicesExpired, 1);
    assert.equal(artifact.totals.financial.settlementRate, 0.5);
    assert.deepEqual(artifact.totals.financial.grossVolumeByAsset, {
      XLM: '200.0000000',
      [`USDC:${USDC_ISSUER}`]: '300.1234567',
    });
    assert.deepEqual(artifact.totals.financial.settledVolumeByAsset, {
      XLM: '125.5000000',
      [`USDC:${USDC_ISSUER}`]: '250.1234567',
    });
    assert.equal(artifact.totals.financial.avgSettlementLatencyMs, 90_000);

    assert.equal(artifact.totals.operational.operationsTotal, 3);
    assert.equal(artifact.totals.operational.operationsSucceeded, 2);
    assert.equal(artifact.totals.operational.operationsFailed, 1);
    assert.equal(artifact.totals.operational.failureRate, 0.3333);
    assert.deepEqual(artifact.totals.operational.failuresByCode, { HORIZON_UNAVAILABLE: 1 });
    assert.equal(artifact.totals.operational.jobsSucceeded, 1);
    assert.equal(artifact.totals.operational.jobsDeadLettered, 1);
    assert.equal(artifact.totals.operational.jobRetriesTotal, 5); // (2-1) + (5-1)
    assert.equal(artifact.totals.operational.slaBreaches, 2); // 1 latency breach + 1 dead job

    // Ensure no raw PII or unmasked wallet keys leak into serialized body
    assert.ok(!artifact.body.includes('alice-pii@example.com'));
    assert.ok(!artifact.body.includes('Alice Customer'));
    assert.ok(!artifact.body.includes('Confidential consulting invoice'));
    assert.ok(!artifact.body.includes(SELLER_A));
    assert.ok(artifact.body.includes(anonymizeSellerCohort(SELLER_A)));
  });

  it('filters by date ranges and supports filling empty buckets across windows', () => {
    const invoices = [
      makeInvoice('d1', { createdAt: new Date('2026-10-10T12:00:00.000Z'), amount: 10 }),
      makeInvoice('d2', { createdAt: new Date('2026-10-12T12:00:00.000Z'), amount: 20 }),
      makeInvoice('d3', { createdAt: new Date('2026-10-15T12:00:00.000Z'), amount: 30 }),
    ];

    const filtered = generateHistoricalTrendExport(
      {
        actor: MAINTAINER,
        granularity: 'day',
        from: '2026-10-11T00:00:00.000Z',
        to: '2026-10-13T23:59:59.000Z',
        fillEmptyBuckets: true,
      },
      { invoices },
      NOW
    );

    // Oct 11, Oct 12, Oct 13 -> 3 daily buckets, only Oct 12 has 1 invoice
    assert.equal(filtered.meta.sourceCounts.invoicesEvaluated, 1);
    assert.equal(filtered.buckets.length, 3);
    assert.equal(filtered.buckets[0].financial.invoicesCreated, 0);
    assert.equal(filtered.buckets[1].financial.invoicesCreated, 1);
    assert.equal(filtered.buckets[2].financial.invoicesCreated, 0);
    assert.equal(filtered.totals.financial.grossVolumeByAsset.XLM, '20.0000000');

    // Invalid date range (from > to) is rejected
    assert.throws(
      () =>
        generateHistoricalTrendExport(
          {
            actor: MAINTAINER,
            from: '2026-10-15T00:00:00.000Z',
            to: '2026-10-10T00:00:00.000Z',
          },
          { invoices },
          NOW
        ),
      (err: unknown) => err instanceof TrendExportValidationError
    );
  });

  it('handles empty source data cleanly in both JSON and CSV formats', () => {
    const emptyJson = generateHistoricalTrendExport(
      { actor: MAINTAINER, granularity: 'hour', format: 'json' },
      { invoices: [], operations: [], jobs: [] },
      NOW
    );

    assert.equal(emptyJson.buckets.length, 0);
    assert.equal(emptyJson.meta.bucketCount, 0);
    assert.equal(emptyJson.totals.financial.invoicesCreated, 0);
    assert.equal(emptyJson.totals.financial.settlementRate, 0);
    assert.equal(emptyJson.totals.operational.operationsTotal, 0);
    assert.equal(emptyJson.totals.operational.failureRate, 0);

    const emptyCsv = generateHistoricalTrendExport(
      { actor: MAINTAINER, granularity: 'week', format: 'csv' },
      {},
      NOW
    );
    assert.equal(emptyCsv.contentType, 'text/csv; charset=utf-8');
    const lines = emptyCsv.body.trim().split('\r\n');
    assert.equal(lines.length, 1); // Header row only
    assert.match(lines[0], /^schema,schemaVersion,granularity,windowStart/);
  });

  it('denies unauthorized callers and blocks sensitive or private dimensions', () => {
    for (const role of ['seller', 'payer', 'anonymous', '']) {
      assert.throws(
        () =>
          generateHistoricalTrendExport(
            { actor: { id: 'user-1', role } },
            { invoices: [] },
            NOW
          ),
        (err: unknown) =>
          err instanceof TrendExportPermissionError && err.code === 'TREND_EXPORT_FORBIDDEN'
      );
    }

    for (const sensitiveDim of [
      'customerEmail',
      'payerEmail',
      'payerName',
      'sellerPublicKey',
      'rawMemo',
      'ip',
      'secret',
      'unapprovedCustomField',
    ]) {
      assert.throws(
        () =>
          generateHistoricalTrendExport(
            { actor: MAINTAINER, dimensions: ['asset', sensitiveDim] },
            { invoices: [] },
            NOW
          ),
        (err: unknown) =>
          err instanceof TrendExportPermissionError &&
          err.code === 'SENSITIVE_DIMENSION_FORBIDDEN' &&
          Boolean(err.blockedDimensions?.includes(sensitiveDim))
      );
    }
  });

  it('bounds large result sets with maxSourceRecords and maxBuckets truncation flags', () => {
    const largeInvoices: StoredInvoice[] = Array.from({ length: 250 }, (_, idx) =>
      makeInvoice(`bulk-${idx}`, {
        amount: 10,
        createdAt: new Date(Date.UTC(2026, 0, 1 + idx, 12, 0, 0)),
      })
    );

    const capped = generateHistoricalTrendExport(
      {
        actor: MAINTAINER,
        granularity: 'day',
        maxSourceRecords: 100,
        maxBuckets: 30,
      },
      { invoices: largeInvoices },
      NOW
    );

    assert.equal(capped.meta.sourceCounts.invoicesEvaluated, 100);
    assert.equal(capped.meta.bucketCount, 30);
    assert.equal(capped.meta.truncated, true);
    assert.deepEqual(capped.meta.truncationReasons, [
      'MAX_SOURCE_RECORDS_REACHED',
      'MAX_BUCKETS_REACHED',
    ]);
  });

  it('aligns hour, day, week, and month windows deterministically in UTC', () => {
    const sample = new Date('2026-10-18T14:37:22.500Z'); // Sunday
    assert.equal(floorToWindowStart(sample, 'hour').toISOString(), '2026-10-18T14:00:00.000Z');
    assert.equal(floorToWindowStart(sample, 'day').toISOString(), '2026-10-18T00:00:00.000Z');
    assert.equal(floorToWindowStart(sample, 'week').toISOString(), '2026-10-12T00:00:00.000Z'); // Monday
    assert.equal(floorToWindowStart(sample, 'month').toISOString(), '2026-10-01T00:00:00.000Z');

    const monthStart = floorToWindowStart(sample, 'month');
    assert.equal(advanceWindow(monthStart, 'month').toISOString(), '2026-11-01T00:00:00.000Z');
  });

  describe('HTTP endpoint /api/ops/trends/export', () => {
    const ADMIN = 'trend-export-admin-token';
    let server: Server;
    let baseUrl: string;

    before(async () => {
      const app = express();
      app.use(express.json());
      const storage: any = {
        getAllInvoices: async () => [makeInvoice('http-inv-1', { amount: 42 })],
      };
      app.use('/api', createOpsRouter({ storage, adminToken: ADMIN, approvals: null, capabilities: null }));
      server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/trends/export`;
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('exports versioned trends for authorized maintainers and rejects sensitive dimensions', async () => {
      const okRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ granularity: 'day', dimensions: ['asset'] }),
      });
      assert.equal(okRes.status, 200);
      const payload = (await okRes.json()) as any;
      assert.equal(payload.success, true);
      assert.equal(payload.data.meta.schema, TREND_EXPORT_SCHEMA_ID);
      assert.equal(payload.data.totals.financial.grossVolumeByAsset.XLM, '42.0000000');

      const deniedRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ dimensions: ['customerEmail'] }),
      });
      assert.equal(deniedRes.status, 403);
      const deniedBody = (await deniedRes.json()) as any;
      assert.equal(deniedBody.code, 'SENSITIVE_DIMENSION_FORBIDDEN');
      assert.equal(deniedBody.explanation.reasonCode, 'SENSITIVE_DIMENSION_FORBIDDEN');
    });
  });
});
