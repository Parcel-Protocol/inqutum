/**
 * User-Safe Degraded Mode for Unavailable Dependencies — Test Suite.
 *
 * Covers:
 *  - Normal path: all dependencies healthy; capability decisions allowed; requests succeed.
 *  - Failure path:
 *      - Stellar Horizon down/timing out: payment verification returns 202 VERIFICATION_DEFERRED
 *        with Retry-After header and zero false positives (invoice not marked paid).
 *      - PostgreSQL down: invoice creation/reading/settling returns 503 STORAGE_UNAVAILABLE.
 *      - Email provider down: email delivery returns 202 EMAIL_DEFERRED with Retry-After: 60.
 *  - Retry path: probe recovery or override removal clears degraded state; retry succeeds.
 *  - Authorization path: admin token enforcement on /ops/degraded-mode/* routes.
 *  - Middleware path: requireCapability Express middleware sets standard headers and envelopes.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  DegradedModeService,
} from '../src/ops/degraded-mode.service';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers';
import { createOpsRouter } from '../src/routes/ops.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { StoredInvoice } from '../src/storage/invoice-storage';

const SELLER = `G${'A'.repeat(55)}`;
const PAYER = `G${'B'.repeat(55)}`;
const TX_HASH = 'a'.repeat(64);

describe('User-Safe Degraded Mode for Unavailable Dependencies', () => {
  let storage: MemoryInvoiceStorage;
  let degradedService: DegradedModeService;

  beforeEach(() => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
    degradedService = new DegradedModeService({ cacheTtlMs: 0 }); // No caching during unit tests
  });

  // ── 1. Normal Path ─────────────────────────────────────────────────────────
  describe('Normal Path: All Dependencies Healthy', () => {
    it('allows all capabilities when probes report healthy', async () => {
      degradedService.registerProbe('stellar_horizon', async () => ({ ok: true, latencyMs: 50 }));
      degradedService.registerProbe('postgres', async () => ({ ok: true, latencyMs: 10 }));
      degradedService.registerProbe('redis_queue', async () => ({ ok: true, latencyMs: 5 }));
      degradedService.registerProbe('email_provider', async () => ({ ok: true, latencyMs: 100 }));

      const status = await degradedService.getStatus();
      assert.equal(status.overall, 'healthy');
      assert.equal(status.capabilities['payment.verify'].allowed, true);
      assert.equal(status.capabilities['invoice.create'].allowed, true);
      assert.equal(status.capabilities['invoice.read'].allowed, true);
      assert.equal(status.capabilities['notification.send'].allowed, true);
      assert.equal(status.capabilities['job.enqueue'].allowed, true);
    });

    it('verifies payment normally when Horizon and DB are available', async () => {
      const invoice = await storage.createInvoice({
        amount: 50,
        assetCode: 'XLM',
        sellerPublicKey: SELLER,
        expiresInDays: 7,
      } as any);

      const mockStellar = {
        async getTransaction(_hash: string) {
          return {
            transaction: {
              source_account: PAYER,
              memo: invoice.memo,
              successful: true,
            },
            operations: [
              {
                type: 'payment',
                to: SELLER,
                amount: '50.0000000',
                asset_type: 'native',
              },
            ],
          };
        },
      };

      const handlers = createInvoiceHandlers({
        storage,
        stellar: mockStellar,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set() {
          return this;
        },
      };

      const req: any = {
        params: { id: invoice.id },
        body: { txHash: TX_HASH, payerPublicKey: PAYER },
        correlationId: 'corr-normal-test',
      };

      await handlers.verifyPayment(req, res);

      assert.equal(statusCode, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'PAID');

      // Authoritative storage check
      const updated = await storage.getInvoiceById(invoice.id);
      assert.equal(updated?.status, 'PAID');
    });
  });

  // ── 2. Failure Path: Stellar Horizon Down ──────────────────────────────────
  describe('Failure Path: Stellar Horizon Degradation & Outage', () => {
    it('defers payment verification with 202 and Retry-After: 30 when Horizon probe fails', async () => {
      degradedService.registerProbe('stellar_horizon', async () => ({
        ok: false,
        error: 'connect ETIMEDOUT horizon.stellar.org:443',
      }));

      const invoice = await storage.createInvoice({
        amount: 50,
        assetCode: 'XLM',
        sellerPublicKey: SELLER,
        expiresInDays: 7,
      } as any);

      const handlers = createInvoiceHandlers({
        storage,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const headers: Record<string, string> = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set(k: string, v: string) {
          headers[k] = v;
          return this;
        },
      };

      const req: any = {
        params: { id: invoice.id },
        body: { txHash: TX_HASH },
        correlationId: 'corr-horizon-down-test',
      };

      await handlers.verifyPayment(req, res);

      // Verify user-safe fallback response
      assert.equal(statusCode, 202); // 202 Accepted, never false 404 or premature 400
      assert.equal(body.success, false);
      assert.equal(body.code, 'VERIFICATION_DEFERRED');
      assert.equal(body.degraded, true);
      assert.equal(body.retryAfter, 30);
      assert.match(body.error, /could not reach the Stellar network/i);
      assert.equal(headers['Retry-After'], '30');
      assert.equal(headers['X-Degraded-Mode'], 'true');
      assert.equal(headers['X-Degraded-Dependency'], 'stellar_horizon');

      // Invariant: payment state MUST NOT be marked paid or altered
      const unmodified = await storage.getInvoiceById(invoice.id);
      assert.equal(unmodified?.status, 'PENDING');
      assert.equal(unmodified?.paymentTxHash, undefined);
    });

    it('intercepts live Horizon timeouts during getTransaction and returns 202 VERIFICATION_DEFERRED', async () => {
      const invoice = await storage.createInvoice({
        amount: 25,
        assetCode: 'XLM',
        sellerPublicKey: SELLER,
        expiresInDays: 7,
      } as any);

      // Stellar service throws Horizon timeout
      const throwingStellar = {
        async getTransaction(_hash: string) {
          throw new Error('request to https://horizon-testnet.stellar.org/transactions failed, reason: ESOCKETTIMEDOUT');
        },
      };

      const handlers = createInvoiceHandlers({
        storage,
        stellar: throwingStellar,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const headers: Record<string, string> = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set(k: string, v: string) {
          headers[k] = v;
          return this;
        },
      };

      const req: any = {
        params: { id: invoice.id },
        body: { txHash: TX_HASH },
        correlationId: 'corr-live-timeout',
      };

      await handlers.verifyPayment(req, res);

      assert.equal(statusCode, 202);
      assert.equal(body.code, 'VERIFICATION_DEFERRED');
      assert.equal(body.degraded, true);
      assert.equal(headers['Retry-After'], '30');
      assert.equal(headers['X-Degraded-Dependency'], 'stellar_horizon');

      // Verify invoice remains PENDING
      const postCheck = await storage.getInvoiceById(invoice.id);
      assert.equal(postCheck?.status, 'PENDING');
    });

    it('still returns 404 TRANSACTION_NOT_FOUND when Horizon is healthy and transaction truly does not exist', async () => {
      const invoice = await storage.createInvoice({
        amount: 25,
        assetCode: 'XLM',
        sellerPublicKey: SELLER,
        expiresInDays: 7,
      } as any);

      // Normal 404 from Horizon API (not an outage/timeout)
      const notFoundStellar = {
        async getTransaction(_hash: string) {
          const err: any = new Error('Transaction not found');
          err.response = { status: 404 };
          throw err;
        },
      };

      const handlers = createInvoiceHandlers({
        storage,
        stellar: notFoundStellar,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set() {
          return this;
        },
      };

      const req: any = {
        params: { id: invoice.id },
        body: { txHash: TX_HASH },
        correlationId: 'corr-genuine-not-found',
      };

      await handlers.verifyPayment(req, res);

      // A genuine missing transaction is a standard 404, not degraded 202
      assert.equal(statusCode, 404);
      assert.equal(body.code, 'TRANSACTION_NOT_FOUND');
      assert.equal(body.degraded, undefined);
    });
  });

  // ── 3. Failure Path: PostgreSQL Outage (Refuse Fallback) ───────────────────
  describe('Failure Path: PostgreSQL Outage', () => {
    it('refuses invoice creation with 503 STORAGE_UNAVAILABLE and Retry-After: 15', async () => {
      degradedService.setOverride('postgres', 'down', 'Database failover maintenance');

      const handlers = createInvoiceHandlers({
        storage,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const headers: Record<string, string> = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set(k: string, v: string) {
          headers[k] = v;
          return this;
        },
      };

      const req: any = {
        body: {
          amount: 100,
          assetCode: 'XLM',
          sellerPublicKey: SELLER,
        },
        correlationId: 'corr-db-down',
      };

      await handlers.createInvoice(req, res);

      assert.equal(statusCode, 503);
      assert.equal(body.code, 'STORAGE_UNAVAILABLE');
      assert.equal(body.degraded, true);
      assert.equal(headers['Retry-After'], '15');
      assert.equal(headers['X-Degraded-Dependency'], 'postgres');
      assert.match(body.error, /Invoices cannot be created right now/i);
    });

    it('refuses payment verification with 503 STORAGE_UNAVAILABLE when Postgres is down even if Horizon is healthy', async () => {
      // Postgres down takes precedence (refuse > defer)
      degradedService.setOverride('postgres', 'down', 'Primary database offline');

      const handlers = createInvoiceHandlers({
        storage,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const headers: Record<string, string> = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set(k: string, v: string) {
          headers[k] = v;
          return this;
        },
      };

      const req: any = {
        params: { id: 'inv-any' },
        body: { txHash: TX_HASH },
        correlationId: 'corr-db-verify-down',
      };

      await handlers.verifyPayment(req, res);

      assert.equal(statusCode, 503);
      assert.equal(body.code, 'STORAGE_UNAVAILABLE');
      assert.equal(headers['Retry-After'], '15');
      assert.match(body.error, /Payments cannot be confirmed right now/i);
    });
  });

  // ── 4. Failure Path: Email Provider Down ───────────────────────────────────
  describe('Failure Path: Email Provider Down', () => {
    it('defers email delivery with 202 EMAIL_DEFERRED and Retry-After: 60', async () => {
      degradedService.setOverride('email_provider', 'down', 'SMTP authentication outage');

      const invoice = await storage.createInvoice({
        amount: 30,
        assetCode: 'XLM',
        sellerPublicKey: SELLER,
        customerEmail: 'customer@example.com',
      } as any);

      const handlers = createInvoiceHandlers({
        storage,
        degradedMode: degradedService,
      });

      let statusCode = 0;
      let body: any = null;
      const headers: Record<string, string> = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
        set(k: string, v: string) {
          headers[k] = v;
          return this;
        },
      };

      const req: any = {
        params: { id: invoice.id },
        body: { recipientEmail: 'customer@example.com' },
        correlationId: 'corr-email-down',
      };

      await handlers.sendInvoiceEmail(req, res);

      assert.equal(statusCode, 202);
      assert.equal(body.code, 'EMAIL_DEFERRED');
      assert.equal(body.degraded, true);
      assert.equal(headers['Retry-After'], '60');
      assert.equal(headers['X-Degraded-Dependency'], 'email_provider');
      assert.match(body.error, /Email delivery is delayed/i);
    });
  });

  // ── 5. Retry Path: Recovery & Resumption ───────────────────────────────────
  describe('Retry Path: Recovery After Degradation', () => {
    it('recovers to healthy when manual override is cleared', async () => {
      degradedService.setOverride('stellar_horizon', 'down', 'Temporary outage');
      assert.equal((await degradedService.checkCapability('payment.verify')).allowed, false);

      degradedService.clearOverride('stellar_horizon');
      assert.equal((await degradedService.checkCapability('payment.verify')).allowed, true);
    });
  });

  // ── 6. Middleware: requireCapability ───────────────────────────────────────
  describe('Express Middleware: requireCapability', () => {
    it('intercepts blocked capabilities and passes allowed ones to next()', async () => {
      degradedService.setOverride('redis_queue', 'down', 'Redis connection refused');

      const mw = degradedService.requireCapability('job.enqueue');

      let nextCalled = false;
      let statusCode = 0;
      let body: any = null;
      const res: any = {
        set() {
          return this;
        },
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        },
      };

      const req: any = { correlationId: 'mw-test-1' };
      await mw(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(statusCode, 202);
      assert.equal(body.code, 'JOB_DEFERRED');

      // Now test an allowed capability
      const allowedMw = degradedService.requireCapability('invoice.create');
      let allowedNextCalled = false;
      await allowedMw(req, res, () => {
        allowedNextCalled = true;
      });
      assert.equal(allowedNextCalled, true);
    });
  });

  // ── 7. Authorization Path: Ops HTTP Routes ─────────────────────────────────
  describe('Authorization Path: /ops/degraded-mode Routes', () => {
    const ADMIN_TOKEN = 'secret-ops-token-xyz';
    let app: express.Express;
    let server: ReturnType<express.Express['listen']>;
    let baseUrl: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      app.use(
        '/api',
        createOpsRouter({
          storage,
          adminToken: ADMIN_TOKEN,
          degradedMode: degradedService,
          approvals: null,
        })
      );

      server = app.listen(0);
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/degraded-mode`;
    });

    const request = (
      method: string,
      path: string,
      body?: unknown,
      token: string | null = ADMIN_TOKEN
    ) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    it('rejects unauthenticated requests with 401', async () => {
      try {
        const noToken = await request('GET', '/status', undefined, null);
        assert.equal(noToken.status, 401);

        const badToken = await request('GET', '/status', undefined, 'wrong-token');
        assert.equal(badToken.status, 401);
      } finally {
        server.close();
      }
    });

    it('allows authorized operators to inspect status, set overrides, and clear them', async () => {
      try {
        // 1. Inspect status
        const statusRes = await request('GET', '/status');
        assert.equal(statusRes.status, 200);
        const statusBody = await statusRes.json();
        assert.equal(statusBody.success, true);
        assert.ok(statusBody.data.capabilities['payment.verify']);

        // 2. Set override
        const overrideRes = await request('POST', '/overrides', {
          dependency: 'stellar_horizon',
          state: 'down',
          reason: 'Incident drill #44',
        });
        assert.equal(overrideRes.status, 201);
        const overrideBody = await overrideRes.json();
        assert.equal(overrideBody.data.dependency, 'stellar_horizon');
        assert.equal(overrideBody.data.state, 'down');

        // 3. Verify capability status reflects override
        const capRes = await request('GET', '/capabilities/payment.verify');
        assert.equal(capRes.status, 200);
        const capBody = await capRes.json();
        assert.equal(capBody.data.allowed, false);
        assert.equal(capBody.data.fallback.code, 'VERIFICATION_DEFERRED');

        // 4. Delete override
        const deleteRes = await request('DELETE', '/overrides/stellar_horizon');
        assert.equal(deleteRes.status, 200);
        const deleteBody = await deleteRes.json();
        assert.equal(deleteBody.data.cleared, true);

        // 5. Verify capability recovered
        const capRecovered = await request('GET', '/capabilities/payment.verify');
        assert.equal((await capRecovered.json()).data.allowed, true);
      } finally {
        server.close();
      }
    });
  });
});
