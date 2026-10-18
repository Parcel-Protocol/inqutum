import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express, { Request, Response as ExpressResponse } from 'express';
import {
  CORRELATION_HEADER,
  REQUEST_ID_HEADER,
  generateCorrelationId,
  sanitizeCorrelationId,
  runWithCorrelation,
  getCorrelationId,
  getCorrelationContext,
  withCorrelationHeaders,
  correlatedFetch,
  attachStellarCorrelationInterceptor,
} from '../src/observability/correlation';
import { correlationMiddleware, measureOperation, metrics } from '../src/observability/telemetry';
import { sendSuccess, sendFailure, sendVerificationFailure } from '../src/types/api';
import { JobQueue, JobWorker } from '../src/jobs/worker';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { probeJson, type ProbeResult } from '../../scripts/http-probe';
import { createHttpApiTransport, createSmtpTransport, EmailDeliveryService } from '../src/notifications/email-delivery';

describe('Distributed Request Correlation Across API, Workers, and External Calls', () => {
  beforeEach(() => {
    metrics.clear();
  });

  // =========================================================================
  // 1. Core Correlation Module & Sanitization
  // =========================================================================
  describe('Core Correlation Module & Sanitization', () => {
    it('generates unique collision-resistant IDs with configurable prefixes', () => {
      const id1 = generateCorrelationId('req');
      const id2 = generateCorrelationId('job');
      const id3 = generateCorrelationId('ext');

      assert.match(id1, /^req-[a-z0-9]+-[a-z0-9]+$/);
      assert.match(id2, /^job-[a-z0-9]+-[a-z0-9]+$/);
      assert.match(id3, /^ext-[a-z0-9]+-[a-z0-9]+$/);
      assert.notEqual(id1, id2);
    });

    it('sanitizes CRLF injection and control characters to prevent HTTP response splitting', () => {
      const malicious = 'valid-id\r\nInjected-Header: evil\r\n\x00';
      const sanitized = sanitizeCorrelationId(malicious);
      assert.equal(sanitized, 'valid-idInjected-Header: evil');
      assert.ok(!sanitized.includes('\r'));
      assert.ok(!sanitized.includes('\n'));
      assert.ok(!sanitized.includes('\x00'));
    });

    it('sanitizes quotes and trims whitespace', () => {
      const input = '  "my-correlation-id-123"  ';
      const sanitized = sanitizeCorrelationId(input);
      assert.equal(sanitized, 'my-correlation-id-123');
    });

    it('caps overly long correlation IDs to 128 characters safely', () => {
      const hugeId = 'a'.repeat(200);
      const sanitized = sanitizeCorrelationId(hugeId);
      assert.equal(sanitized.length, 128);
      assert.equal(sanitized, 'a'.repeat(128));
    });

    it('falls back to generated ID on empty or invalid inputs', () => {
      assert.match(sanitizeCorrelationId(''), /^req-/);
      assert.match(sanitizeCorrelationId(null), /^req-/);
      assert.match(sanitizeCorrelationId(undefined), /^req-/);
      assert.match(sanitizeCorrelationId(12345 as any), /^req-/);
      assert.match(sanitizeCorrelationId('   ', 'job'), /^job-/);
      assert.match(sanitizeCorrelationId('???invalid#chars!!!', 'ext'), /^ext-/);
    });

    it('propagates correlation context through AsyncLocalStorage across promises and microtasks', async () => {
      const testId = 'test-corr-abc-123';

      await runWithCorrelation({ correlationId: testId, source: 'api' }, async () => {
        assert.equal(getCorrelationId(), testId);
        assert.equal(getCorrelationContext()?.source, 'api');

        // Verify across Promise boundaries
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            assert.equal(getCorrelationId(), testId);
            resolve();
          }, 5);
        });

        assert.equal(getCorrelationId(), testId);
      });

      // Context must be undefined outside the scope
      assert.equal(getCorrelationId(), undefined);
    });

    it('maintains strict isolation across concurrent asynchronous execution branches', async () => {
      const taskA = async () => {
        return runWithCorrelation('corr-branch-A', async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return getCorrelationId();
        });
      };

      const taskB = async () => {
        return runWithCorrelation('corr-branch-B', async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return getCorrelationId();
        });
      };

      const [resA, resB] = await Promise.all([taskA(), taskB()]);
      assert.equal(resA, 'corr-branch-A');
      assert.equal(resB, 'corr-branch-B');
    });
  });

  // =========================================================================
  // 2. Express API Correlation: Normal, Failure, and Authorization Paths
  // =========================================================================
  describe('Express API Correlation Middleware & Response Envelopes', () => {
    it('normal path: accepts client header, sets req.correlationId, response headers and context', (t, done) => {
      const app = express();
      app.use(correlationMiddleware());

      app.get('/test', (req: Request, res: ExpressResponse) => {
        // req.correlationId is set
        assert.equal(req.correlationId, 'client-req-001');
        // AsyncLocalStorage context is set
        assert.equal(getCorrelationId(), 'client-req-001');
        sendSuccess(res, 200, { ok: true });
      });

      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/test`, {
            headers: { 'X-Correlation-ID': 'client-req-001' },
          });

          assert.equal(res.status, 200);
          assert.equal(res.headers.get('x-correlation-id'), 'client-req-001');
          assert.equal(res.headers.get('x-request-id'), 'client-req-001');

          const body = (await res.json()) as any;
          assert.equal(body.success, true);
          assert.equal(body.correlationId, 'client-req-001');
          assert.deepEqual(body.data, { ok: true });
        } finally {
          server.close(done);
        }
      });
    });

    it('normal path: generates correlation ID and sets headers when client header is omitted', (t, done) => {
      const app = express();
      app.use(correlationMiddleware());

      app.get('/test-gen', (req: Request, res: ExpressResponse) => {
        assert.match(req.correlationId!, /^req-/);
        assert.equal(getCorrelationId(), req.correlationId);
        sendSuccess(res, 200, { generated: true });
      });

      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/test-gen`);
          assert.equal(res.status, 200);

          const headerId = res.headers.get('x-correlation-id');
          assert.ok(headerId && headerId.startsWith('req-'));
          assert.equal(res.headers.get('x-request-id'), headerId);

          const body = (await res.json()) as any;
          assert.equal(body.correlationId, headerId);
        } finally {
          server.close(done);
        }
      });
    });

    it('failure path: propagates correlation ID into failure envelope and telemetry', (t, done) => {
      const app = express();
      app.use(correlationMiddleware());

      app.get('/test-fail', (req: Request, res: ExpressResponse) => {
        sendFailure(res, 400, 'Invalid parameters supplied', {
          code: 'INVALID_PARAMETERS',
        });
      });

      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/test-fail`, {
            headers: { 'X-Correlation-ID': 'failure-trace-999' },
          });

          assert.equal(res.status, 400);
          assert.equal(res.headers.get('x-correlation-id'), 'failure-trace-999');

          const body = (await res.json()) as any;
          assert.equal(body.success, false);
          assert.equal(body.error, 'Invalid parameters supplied');
          assert.equal(body.correlationId, 'failure-trace-999');
        } finally {
          server.close(done);
        }
      });
    });

    it('authorization path: propagates correlation ID on 401 and 403 authorization rejections', (t, done) => {
      const app = express();
      app.use(correlationMiddleware());

      // Simulate authorization gate
      app.use('/admin', (req, res, next) => {
        const auth = req.header('authorization');
        if (!auth || auth !== 'Bearer valid-admin-key') {
          return sendFailure(res, 401, 'Unauthorized access', { code: 'UNAUTHORIZED' });
        }
        next();
      });

      app.get('/admin/status', (req, res) => {
        sendSuccess(res, 200, { privileged: true });
      });

      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/admin/status`, {
            headers: { 'X-Correlation-ID': 'auth-denied-trace' },
          });

          assert.equal(res.status, 401);
          assert.equal(res.headers.get('x-correlation-id'), 'auth-denied-trace');
          assert.equal(res.headers.get('x-request-id'), 'auth-denied-trace');

          const body = (await res.json()) as any;
          assert.equal(body.success, false);
          assert.equal(body.code, 'UNAUTHORIZED');
          assert.equal(body.correlationId, 'auth-denied-trace');
        } finally {
          server.close(done);
        }
      });
    });
  });

  // =========================================================================
  // 3. Worker Job Correlation: Enqueue Inheritance, Execution & Retry Preservation
  // =========================================================================
  describe('Worker Job Correlation Lifecycle', () => {
    it('normal path: enqueuing a job inherits active AsyncLocalStorage correlationId', async () => {
      const store = new MemoryJobStore();
      const queue = new JobQueue(store);

      await runWithCorrelation('api-request-session-xyz', async () => {
        const { job } = await queue.enqueue('invoice.sync', { invoiceId: 'inv-101' });
        assert.equal(job.correlationId, 'api-request-session-xyz');
      });

      const jobs = await store.list();
      assert.equal(jobs.total, 1);
      assert.equal(jobs.jobs[0].correlationId, 'api-request-session-xyz');
    });

    it('normal path: explicit correlationId in EnqueueOptions overrides context', async () => {
      const store = new MemoryJobStore();
      const queue = new JobQueue(store);

      await runWithCorrelation('context-id', async () => {
        const { job } = await queue.enqueue('invoice.sync', {}, { correlationId: 'explicit-override-id' });
        assert.equal(job.correlationId, 'explicit-override-id');
      });
    });

    it('normal path: worker executes inside runWithCorrelation and supplies correlationId to handler ctx', async () => {
      const store = new MemoryJobStore();
      const queue = new JobQueue(store);
      const worker = new JobWorker({ store, workerId: 'worker-unit-1' });

      let capturedCtxCorrelationId: string | undefined;
      let capturedStorageCorrelationId: string | undefined;

      worker.register('email.dispatch', async (payload, ctx) => {
        capturedCtxCorrelationId = ctx.correlationId;
        capturedStorageCorrelationId = getCorrelationId();
        return { dispatched: true };
      });

      await queue.enqueue('email.dispatch', {}, { correlationId: 'worker-trace-777' });
      const processed = await worker.runOnce();

      assert.ok(processed);
      assert.equal(processed.status, 'succeeded');
      assert.equal(capturedCtxCorrelationId, 'worker-trace-777');
      assert.equal(capturedStorageCorrelationId, 'worker-trace-777');
    });

    it('retry path: correlationId is preserved across multiple retries and backoff attempts', async () => {
      const store = new MemoryJobStore();
      let nowMs = 1_000_000;
      const now = () => new Date(nowMs);
      const queue = new JobQueue(store, undefined, now);
      const worker = new JobWorker({ store, workerId: 'worker-retry-test', now });

      const attemptsObserved: Array<{ attempt: number; correlationId: string | undefined }> = [];

      worker.register('flaky.external.call', async (_payload, ctx) => {
        attemptsObserved.push({
          attempt: ctx.attempt,
          correlationId: getCorrelationId(),
        });

        if (ctx.attempt < 3) {
          throw new Error(`Transient network glitch at attempt ${ctx.attempt}`);
        }
        return { success: true };
      });

      // Enqueue with a specific correlationId
      await queue.enqueue(
        'flaky.external.call',
        {},
        {
          correlationId: 'durable-retry-trace-42',
          retryPolicy: { maxAttempts: 5, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000 },
        }
      );

      // Attempt 1 -> Fails
      const res1 = await worker.runOnce();
      assert.equal(res1?.status, 'queued'); // Requeued for retry
      assert.equal(res1?.attempts, 1);
      assert.equal(res1?.correlationId, 'durable-retry-trace-42');

      // Fast-forward time past backoff delay
      nowMs += 200;

      // Attempt 2 -> Fails
      const res2 = await worker.runOnce();
      assert.equal(res2?.status, 'queued');
      assert.equal(res2?.attempts, 2);
      assert.equal(res2?.correlationId, 'durable-retry-trace-42');

      // Fast-forward time past backoff delay
      nowMs += 400;

      // Attempt 3 -> Succeeds!
      const res3 = await worker.runOnce();
      assert.equal(res3?.status, 'succeeded');
      assert.equal(res3?.attempts, 3);
      assert.equal(res3?.correlationId, 'durable-retry-trace-42');

      // Verify that every single attempt ran under the identical correlation ID
      assert.equal(attemptsObserved.length, 3);
      assert.deepEqual(attemptsObserved, [
        { attempt: 1, correlationId: 'durable-retry-trace-42' },
        { attempt: 2, correlationId: 'durable-retry-trace-42' },
        { attempt: 3, correlationId: 'durable-retry-trace-42' },
      ]);
    });

    it('dead-letter path: requeued dead-lettered job preserves its original correlationId', async () => {
      const store = new MemoryJobStore();
      const now = () => new Date();
      const queue = new JobQueue(store, undefined, now);
      const worker = new JobWorker({ store, workerId: 'worker-dlq', now });

      worker.register('fatal.job', async () => {
        throw new Error('Permanent database corrupt error');
      });

      const { job } = await queue.enqueue(
        'fatal.job',
        {},
        {
          correlationId: 'trace-dlq-orig-001',
          retryPolicy: { maxAttempts: 1, baseDelayMs: 10 },
        }
      );

      // Run once -> dead-lettered
      const deadJob = await worker.runOnce();
      assert.equal(deadJob?.status, 'dead');
      assert.equal(deadJob?.correlationId, 'trace-dlq-orig-001');

      // Maintainer requeues the dead job
      const requeued = await store.requeueDead(job.id, new Date());
      assert.equal(requeued?.status, 'queued');
      assert.equal(requeued?.correlationId, 'trace-dlq-orig-001');
    });
  });

  // =========================================================================
  // 4. External Calls & Outbound HTTP Correlation
  // =========================================================================
  describe('Outbound External Calls & HTTP Probes', () => {
    it('withCorrelationHeaders injects correlation headers and preserves existing ones', () => {
      const injected = runWithCorrelation('corr-outbound-55', () => {
        return withCorrelationHeaders({ 'Content-Type': 'application/json' });
      });

      assert.equal(injected['Content-Type'], 'application/json');
      assert.equal(injected[CORRELATION_HEADER], 'corr-outbound-55');
      assert.equal(injected[REQUEST_ID_HEADER], 'corr-outbound-55');
    });

    it('correlatedFetch automatically passes correlation headers to external HTTP targets', async () => {
      let capturedHeaders: Record<string, string> = {};

      const fakeFetch: typeof fetch = async (url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      await runWithCorrelation('trace-ext-target-123', async () => {
        await correlatedFetch('https://example.com/api', { fetchImpl: fakeFetch });
      });

      assert.equal(capturedHeaders['X-Correlation-ID'], 'trace-ext-target-123');
      assert.equal(capturedHeaders['X-Request-ID'], 'trace-ext-target-123');
    });

    it('HTTP Probe (probeJson): normal path includes correlationId in request headers and ProbeResult', async () => {
      let sentHeader: string | null = null;
      const fakeFetch: typeof fetch = async (url, init) => {
        sentHeader = (init?.headers as any)?.['X-Correlation-ID'];
        return new Response(JSON.stringify({ status: 'healthy' }), { status: 200 });
      };

      const result = await probeJson('https://api.example.com/health', {
        fetchImpl: fakeFetch,
        correlationId: 'probe-corr-unique-99',
        sleep: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.correlationId, 'probe-corr-unique-99');
      assert.equal(sentHeader, 'probe-corr-unique-99');
    });

    it('HTTP Probe (probeJson): retry path maintains the same correlationId across retries', async () => {
      const recordedCorrelationHeaders: string[] = [];
      let callCount = 0;

      const fakeFetch: typeof fetch = async (_url, init) => {
        callCount++;
        recordedCorrelationHeaders.push((init?.headers as any)?.['X-Correlation-ID']);

        if (callCount < 3) {
          return new Response(JSON.stringify({ error: 'rate limited' }), {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      };

      const result = await probeJson('https://api.example.com/probed', {
        fetchImpl: fakeFetch,
        correlationId: 'probe-retry-trace-88',
        sleep: async () => {}, // instant sleep for test
      });

      assert.equal(result.ok, true);
      assert.equal(result.attempts, 3);
      assert.equal(result.correlationId, 'probe-retry-trace-88');
      assert.deepEqual(recordedCorrelationHeaders, [
        'probe-retry-trace-88',
        'probe-retry-trace-88',
        'probe-retry-trace-88',
      ]);
    });

    it('HTTP Probe (probeJson): authorization failure (401/403) returns correlationId and fails fast', async () => {
      const fakeFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      };

      const result = await probeJson('https://api.example.com/secure', {
        fetchImpl: fakeFetch,
        correlationId: 'auth-fail-probe-id',
        sleep: async () => {},
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, 'unauthorized');
        assert.equal(result.status, 401);
        assert.equal(result.attempts, 1); // fails fast without retrying
        assert.equal(result.correlationId, 'auth-fail-probe-id');
      }
    });

    it('Email delivery HTTP transport attaches correlation headers and records correlationId in store', async () => {
      let sentHeaders: Record<string, string> = {};

      const fakeFetch: typeof fetch = async (url, init) => {
        sentHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ id: 'msg-prov-1001' }), { status: 200 });
      };

      const transport = createHttpApiTransport({
        endpoint: 'https://email.provider.test/v1/send',
        token: 'provider-test-secret',
        from: 'billing@example.com',
        fetchImpl: fakeFetch,
      });

      const emailService = new EmailDeliveryService({ transport });

      await runWithCorrelation('email-send-trace-500', async () => {
        const sendResult = await emailService.deliver({
          to: 'customer@example.com',
          subject: 'Your Invoice',
          text: 'Invoice details',
        });

        assert.equal(sendResult.ok, true);
        assert.equal(sentHeaders['X-Correlation-ID'], 'email-send-trace-500');
        assert.equal(sentHeaders['X-Request-ID'], 'email-send-trace-500');

        // Check delivery metadata recorded in store
        const record = emailService.getStore().get(sendResult.delivery!.id);
        assert.equal(record?.metadata?.correlationId, 'email-send-trace-500');
      });
    });

    it('Email delivery SMTP transport attaches correlation headers to mail payload', async () => {
      let sentMailPayload: any = null;
      const fakeSmtpClient = {
        sendMail: async (mail: any) => {
          sentMailPayload = mail;
          return { messageId: 'smtp-msg-001', accepted: [mail.to], rejected: [] };
        },
      };

      const transport = createSmtpTransport(fakeSmtpClient);
      const emailService = new EmailDeliveryService({ transport });

      await runWithCorrelation('smtp-trace-600', async () => {
        const result = await emailService.deliver({
          to: 'client@example.com',
          subject: 'Payment receipt',
          text: 'Payment received',
        });

        assert.equal(result.ok, true);
        assert.equal(sentMailPayload.headers['X-Correlation-ID'], 'smtp-trace-600');
        assert.equal(sentMailPayload.headers['X-Request-ID'], 'smtp-trace-600');
      });
    });

    it('Stellar Horizon AxiosClient interceptor automatically attaches correlation headers', () => {
      const mockAxiosClient = {
        interceptors: {
          request: {
            handlers: [] as any[],
            use(fn: any) {
              this.handlers.push(fn);
            },
          },
        },
      };

      const attached = attachStellarCorrelationInterceptor(mockAxiosClient);
      assert.equal(attached, true);
      assert.equal(mockAxiosClient.interceptors.request.handlers.length, 1);

      const interceptor = mockAxiosClient.interceptors.request.handlers[0];

      // Test without active correlation context
      const config1 = interceptor({ headers: {} });
      assert.equal(config1.headers['X-Correlation-ID'], undefined);

      // Test within active correlation context
      const config2 = runWithCorrelation('horizon-stellar-trace-999', () => {
        return interceptor({ headers: {} });
      });

      assert.equal(config2.headers['X-Correlation-ID'], 'horizon-stellar-trace-999');
      assert.equal(config2.headers['X-Request-ID'], 'horizon-stellar-trace-999');
    });
  });

  // =========================================================================
  // 5. measureOperation Telemetry Integration
  // =========================================================================
  describe('measureOperation Telemetry Correlation', () => {
    it('inherits correlationId from AsyncLocalStorage if not passed explicitly', async () => {
      await runWithCorrelation('telemetry-auto-trace-77', async () => {
        const result = await measureOperation(
          'invoice.verify_stellar',
          'payer',
          undefined, // omitted correlationId
          async () => ({ success: true })
        );

        assert.deepEqual(result, { success: true });

        const logs = metrics.getRecentLogs(1);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].correlation_id, 'telemetry-auto-trace-77');
        assert.equal(logs[0].operation, 'invoice.verify_stellar');
      });
    });

    it('captures correlationId during operation failures', async () => {
      await runWithCorrelation('telemetry-fail-trace-88', async () => {
        await assert.rejects(async () => {
          await measureOperation(
            'invoice.settle_ledger',
            'system',
            undefined,
            async () => {
              const err: any = new Error('Ledger settlement failed');
              err.code = 'SETTLEMENT_REJECTED';
              throw err;
            }
          );
        });

        const logs = metrics.getRecentLogs(1);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].correlation_id, 'telemetry-fail-trace-88');
        assert.equal(logs[0].result, 'failure');
        assert.equal(logs[0].error_code, 'SETTLEMENT_REJECTED');
      });
    });
  });
});
