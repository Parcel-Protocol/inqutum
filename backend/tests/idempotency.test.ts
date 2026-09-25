import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-store.ts';
import { PostgresIdempotencyStore } from '../src/idempotency/postgres-store.ts';
import { canonicalJson, idempotency, requestFingerprint } from '../src/idempotency/middleware.ts';
import {
  DEFAULT_IDEMPOTENCY_LOCK_MS,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_TOMBSTONE_MS,
} from '../src/idempotency/store.ts';
import type { BeginInput, IdempotencyStore } from '../src/idempotency/store.ts';
import { createInvoiceRouter } from '../src/routes/invoice.routes.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { maintainerAuth, walletAuth } from './fixtures/auth.fixture.ts';

// The code under test logs every request; keep the runner's output stream quiet.
for (const method of ['log', 'warn', 'error'] as const) {
  console[method] = () => undefined;
}

const NOW = new Date('2026-09-01T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

const input = (overrides: Partial<BeginInput> = {}): BeginInput => ({
  scope: 'actor-a',
  key: 'key-0000001',
  fingerprint: 'f'.repeat(64),
  now: NOW,
  ttlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
  lockMs: DEFAULT_IDEMPOTENCY_LOCK_MS,
  ...overrides,
});

// ---------------------------------------------------------------------------
// A stand-in for the `idempotency_keys` table: only the statements the store
// issues, matched by their leading text.
// ---------------------------------------------------------------------------

class FakeIdempotencyDb {
  rows = new Map<string, Record<string, any>>();
  failWith: Error | null = null;

  private id = (scope: string, key: string) => `${scope}\u0000${key}`;

  async query(text: string, params: any[] = []) {
    if (this.failWith) throw this.failWith;
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('INSERT INTO idempotency_keys')) {
      const id = this.id(params[0], params[1]);
      if (this.rows.has(id)) return { rows: [], rowCount: 0 };
      this.rows.set(id, {
        scope: params[0],
        key: params[1],
        request_hash: params[2],
        status: 'IN_PROGRESS',
        response_status: null,
        response_body: null,
        locked_until: params[3],
        expires_at: params[4],
      });
      return { rows: [{ key: params[1] }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT request_hash, status')) {
      const row = this.rows.get(this.id(params[0], params[1]));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE idempotency_keys SET locked_until')) {
      const row = this.rows.get(this.id(params[0], params[1]));
      if (row && row.status === 'IN_PROGRESS' && new Date(row.locked_until) <= new Date(params[3])) {
        row.locked_until = params[2];
        return { rows: [{ key: params[1] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("UPDATE idempotency_keys SET status = 'COMPLETED'")) {
      const row = this.rows.get(this.id(params[0], params[1]));
      if (row) {
        Object.assign(row, {
          status: 'COMPLETED',
          response_status: params[2],
          // jsonb columns come back parsed
          response_body: JSON.parse(params[3]),
          locked_until: null,
        });
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM idempotency_keys WHERE scope')) {
      const id = this.id(params[0], params[1]);
      const row = this.rows.get(id);
      if (row?.status === 'IN_PROGRESS') {
        this.rows.delete(id);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('DELETE FROM idempotency_keys WHERE expires_at')) {
      let removed = 0;
      for (const [id, row] of this.rows) {
        if (new Date(row.expires_at) < new Date(params[0])) {
          this.rows.delete(id);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }

    throw new Error(`FakeIdempotencyDb: unsupported SQL: ${sql.slice(0, 100)}`);
  }
}

const stores: Array<{ name: string; make: () => IdempotencyStore }> = [
  { name: 'memory store', make: () => new MemoryIdempotencyStore() },
  { name: 'postgres store double', make: () => new PostgresIdempotencyStore(new FakeIdempotencyDb()) },
];

for (const { name, make } of stores) {
  describe(`idempotency store contract: ${name}`, () => {
    it('hands the first request the key, and tells a concurrent duplicate to wait', async () => {
      const store = make();
      assert.deepEqual(await store.begin(input()), { kind: 'new' });
      assert.deepEqual(await store.begin(input()), { kind: 'in_progress' });
    });

    it('lets exactly one of several simultaneous first requests proceed', async () => {
      const store = make();
      const results = await Promise.all(Array.from({ length: 8 }, () => store.begin(input())));
      assert.equal(results.filter((r) => r.kind === 'new').length, 1);
      assert.equal(results.filter((r) => r.kind === 'in_progress').length, 7);
    });

    it('replays the stored response once the first request succeeded (retry after success)', async () => {
      const store = make();
      await store.begin(input());
      await store.complete('actor-a', 'key-0000001', { status: 201, body: { ok: true, n: [1, 2] } }, NOW);

      const retry = await store.begin(input({ now: at(1000) }));
      assert.deepEqual(retry, { kind: 'replay', response: { status: 201, body: { ok: true, n: [1, 2] } } });
    });

    it('runs the request again after a failed attempt released the key (retry after failure)', async () => {
      const store = make();
      await store.begin(input());
      await store.release('actor-a', 'key-0000001');

      assert.deepEqual(await store.begin(input({ now: at(1000) })), { kind: 'new' });
    });

    it('never releases a completed key', async () => {
      const store = make();
      await store.begin(input());
      await store.complete('actor-a', 'key-0000001', { status: 200, body: {} }, NOW);
      await store.release('actor-a', 'key-0000001');

      assert.equal((await store.begin(input())).kind, 'replay');
    });

    it('reports a conflict when the key is reused for a different request', async () => {
      const store = make();
      await store.begin(input());
      const other = input({ fingerprint: 'a'.repeat(64) });

      assert.deepEqual(await store.begin(other), { kind: 'conflict' }, 'while the first is in flight');
      await store.complete('actor-a', 'key-0000001', { status: 200, body: {} }, NOW);
      assert.deepEqual(await store.begin(other), { kind: 'conflict' }, 'after the first completed');
    });

    it('reports an expired key instead of silently re-running it', async () => {
      const store = make();
      await store.begin(input({ ttlMs: 1000 }));
      await store.complete('actor-a', 'key-0000001', { status: 200, body: {} }, NOW);

      assert.deepEqual(await store.begin(input({ ttlMs: 1000, now: at(1001) })), { kind: 'expired' });
      assert.equal((await store.begin(input({ ttlMs: 1000, now: at(999) }))).kind, 'replay');
    });

    it('keeps keys private to an actor', async () => {
      const store = make();
      assert.equal((await store.begin(input({ scope: 'actor-a' }))).kind, 'new');
      assert.equal((await store.begin(input({ scope: 'actor-b' }))).kind, 'new');
    });

    it('lets another request take over an attempt that never finished, but only one of them', async () => {
      const store = make();
      await store.begin(input({ lockMs: 1000 }));

      assert.equal((await store.begin(input({ lockMs: 1000, now: at(500) }))).kind, 'in_progress');
      const later = at(2000);
      const takeovers = await Promise.all([
        store.begin(input({ lockMs: 1000, now: later })),
        store.begin(input({ lockMs: 1000, now: later })),
      ]);
      assert.equal(takeovers.filter((r) => r.kind === 'new').length, 1);
    });

    it('purges keys only after their tombstone window', async () => {
      const store = make();
      await store.begin(input({ ttlMs: 1000 }));
      await store.complete('actor-a', 'key-0000001', { status: 200, body: {} }, NOW);

      assert.equal(await store.purge(at(1000 + IDEMPOTENCY_TOMBSTONE_MS - 1)), 0);
      assert.equal(await store.purge(at(1000 + IDEMPOTENCY_TOMBSTONE_MS + 1)), 1);
      assert.equal((await store.begin(input({ now: at(1000 + IDEMPOTENCY_TOMBSTONE_MS + 2) }))).kind, 'new');
    });
  });
}

describe('postgres idempotency store specifics', () => {
  it('surfaces a database outage rather than hiding it', async () => {
    const db = new FakeIdempotencyDb();
    db.failWith = new Error('connection refused');
    await assert.rejects(() => new PostgresIdempotencyStore(db).begin(input()), /connection refused/);
  });

  it('stores the response as JSON and returns it parsed', async () => {
    const db = new FakeIdempotencyDb();
    const store = new PostgresIdempotencyStore(db);
    await store.begin(input());
    await store.complete('actor-a', 'key-0000001', { status: 201, body: { id: 'x', nested: { a: 1 } } }, NOW);
    assert.equal(db.rows.get('actor-a\u0000key-0000001')?.response_status, 201);
  });
});

describe('request fingerprint', () => {
  it('ignores key order, so a client that reorders its JSON still replays', () => {
    assert.equal(
      requestFingerprint('POST', '/api/invoices', { a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } }),
      requestFingerprint('POST', '/api/invoices', { b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 })
    );
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('distinguishes method, path and any value', () => {
    const base = requestFingerprint('POST', '/api/invoices', { amount: 1 });
    assert.notEqual(base, requestFingerprint('PUT', '/api/invoices', { amount: 1 }));
    assert.notEqual(base, requestFingerprint('POST', '/api/invoices/1/cancel', { amount: 1 }));
    assert.notEqual(base, requestFingerprint('POST', '/api/invoices', { amount: 2 }));
    assert.notEqual(base, requestFingerprint('POST', '/api/invoices', { amount: '1' }));
  });

  it('treats a missing body like null', () => {
    assert.equal(requestFingerprint('POST', '/x', undefined), requestFingerprint('POST', '/x', null));
  });
});

// ---------------------------------------------------------------------------
// HTTP: the middleware on a controllable handler
// ---------------------------------------------------------------------------

interface Slow {
  baseUrl: string;
  executions: () => number;
  setClock(ms: number): void;
  close(): Promise<void>;
}

async function startSlowApp(
  options: {
    store?: IdempotencyStore;
    required?: boolean;
    ttlMs?: number;
    delayMs?: number;
    respond?: (n: number) => { status: number; body: unknown };
  } = {}
): Promise<Slow> {
  let executions = 0;
  let clock = NOW.getTime();
  const app = express();
  app.use(express.json());
  app.post(
    '/write',
    idempotency({
      store: options.store ?? new MemoryIdempotencyStore(),
      required: () => Boolean(options.required),
      ttlMs: () => options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
      now: () => new Date(clock),
    }),
    async (_req, res) => {
      const n = ++executions;
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      const { status, body } = options.respond?.(n) ?? { status: 201, body: { created: n } };
      res.status(status).json(body);
    }
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    executions: () => executions,
    setClock: (ms) => {
      clock = ms;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const post = (baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const KEY = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('idempotency middleware', () => {
  it('runs the handler once and replays the identical response to a duplicate submission', async () => {
    const app = await startSlowApp();
    try {
      const first = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      const second = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.deepEqual(await second.json(), await first.json());
      assert.equal(second.headers.get('idempotent-replayed'), 'true');
      assert.equal(first.headers.get('idempotent-replayed'), null);
      assert.equal(second.headers.get('idempotency-key'), KEY);
      assert.equal(app.executions(), 1, 'the side effect must not run twice');
    } finally {
      await app.close();
    }
  });

  it('replays even when the client reorders the JSON keys', async () => {
    const app = await startSlowApp();
    try {
      await post(app.baseUrl, '/write', { a: 1, b: 2 }, { 'idempotency-key': KEY });
      const again = await post(app.baseUrl, '/write', { b: 2, a: 1 }, { 'idempotency-key': KEY });
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.equal(app.executions(), 1);
    } finally {
      await app.close();
    }
  });

  it('does not deduplicate requests that carry no key', async () => {
    const app = await startSlowApp();
    try {
      await post(app.baseUrl, '/write', { x: 1 });
      await post(app.baseUrl, '/write', { x: 1 });
      assert.equal(app.executions(), 2);
    } finally {
      await app.close();
    }
  });

  it('answers 409 to a duplicate that arrives while the first is still running, then replays', async () => {
    const app = await startSlowApp({ delayMs: 150 });
    try {
      const first = post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const concurrent = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });

      assert.equal(concurrent.status, 409);
      assert.equal((await concurrent.json() as any).code, 'IDEMPOTENCY_IN_PROGRESS');
      assert.equal(concurrent.headers.get('retry-after'), '1');

      const firstResponse = await first;
      assert.equal(firstResponse.status, 201);
      const afterwards = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(afterwards.status, 201);
      assert.equal(afterwards.headers.get('idempotent-replayed'), 'true');
      assert.equal(app.executions(), 1);
    } finally {
      await app.close();
    }
  });

  it('answers 422 when the key is reused for a different request, and does not run it', async () => {
    const app = await startSlowApp();
    try {
      await post(app.baseUrl, '/write', { amount: 1 }, { 'idempotency-key': KEY });
      const collision = await post(app.baseUrl, '/write', { amount: 2 }, { 'idempotency-key': KEY });

      assert.equal(collision.status, 422);
      assert.equal((await collision.json() as any).code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.equal(app.executions(), 1);
    } finally {
      await app.close();
    }
  });

  it('answers 410 for a key used longer ago than the retention window', async () => {
    const app = await startSlowApp({ ttlMs: 60_000 });
    try {
      await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      app.setClock(NOW.getTime() + 61_000);
      const late = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });

      assert.equal(late.status, 410);
      assert.equal((await late.json() as any).code, 'IDEMPOTENCY_KEY_EXPIRED');
      assert.equal(app.executions(), 1, 'an expired key must not silently run the write again');
    } finally {
      await app.close();
    }
  });

  it('releases the key after a failed attempt, so the retry runs (retry after failure)', async () => {
    const app = await startSlowApp({
      respond: (n) =>
        n === 1
          ? { status: 502, body: { success: false, error: 'upstream unavailable' } }
          : { status: 200, body: { success: true, attempt: n } },
    });
    try {
      const failed = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(failed.status, 502);

      const retry = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), null, 'a failure must not be replayed');
      assert.equal(app.executions(), 2);

      const replay = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.equal(((await replay.json()) as any).attempt, 2, 'the success, not the failure, is what is stored');
    } finally {
      await app.close();
    }
  });

  it('does not store 4xx responses either', async () => {
    const app = await startSlowApp({ respond: () => ({ status: 400, body: { success: false } }) });
    try {
      await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(app.executions(), 2);
    } finally {
      await app.close();
    }
  });

  it('frees the key when the client disconnects before a reply', async () => {
    const app = await startSlowApp({ delayMs: 200 });
    try {
      const controller = new AbortController();
      const aborted = fetch(`${app.baseUrl}/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': KEY },
        body: JSON.stringify({ x: 1 }),
        signal: controller.signal,
      }).catch(() => 'aborted');
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort();
      assert.equal(await aborted, 'aborted');
      await new Promise((resolve) => setTimeout(resolve, 40));

      const retry = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.notEqual(retry.status, 409, 'an abandoned attempt must not lock the key');
    } finally {
      await app.close();
    }
  });

  it('rejects malformed keys', async () => {
    const app = await startSlowApp();
    try {
      for (const bad of ['short', 'has spaces in it', 'x'.repeat(256), 'bad/slash/key-1', 'émoji-key-00000']) {
        const response = await post(app.baseUrl, '/write', {}, { 'idempotency-key': bad });
        assert.equal(response.status, 400, bad);
        assert.equal(((await response.json()) as any).code, 'IDEMPOTENCY_KEY_INVALID');
      }
      assert.equal(app.executions(), 0);
    } finally {
      await app.close();
    }
  });

  it('can require a key, refusing a bare write', async () => {
    const app = await startSlowApp({ required: true });
    try {
      const bare = await post(app.baseUrl, '/write', {});
      assert.equal(bare.status, 400);
      assert.equal(((await bare.json()) as any).code, 'IDEMPOTENCY_KEY_REQUIRED');
      assert.equal(app.executions(), 0);
    } finally {
      await app.close();
    }
  });

  it('fails closed when the store is down, rather than running the write unprotected', async () => {
    const db = new FakeIdempotencyDb();
    db.failWith = new Error('connection refused');
    const app = await startSlowApp({ store: new PostgresIdempotencyStore(db) });
    try {
      const response = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as any).code, 'IDEMPOTENCY_STORE_UNAVAILABLE');
      assert.equal(app.executions(), 0);
    } finally {
      await app.close();
    }
  });

  it('works the same over the durable store', async () => {
    const app = await startSlowApp({ store: new PostgresIdempotencyStore(new FakeIdempotencyDb()) });
    try {
      await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      const again = await post(app.baseUrl, '/write', { x: 1 }, { 'idempotency-key': KEY });
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.equal(app.executions(), 1);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The real write paths: create, cancel, verify
// ---------------------------------------------------------------------------

const seller = Keypair.random();
const otherSeller = Keypair.random();
const PAYER = 'G' + 'C'.repeat(55);
const TX = 'a'.repeat(64);

async function startInvoiceApp(stellar?: { getTransaction(hash: string): Promise<any> }) {
  const raw = new MemoryStorage();
  const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createInvoiceRouter({
      storage,
      stellar,
      allowSimulate: true,
      enableRateLimiting: false,
      enableConcurrencyLock: false,
      enableCeilingCheck: false,
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    raw,
    storage,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const createBody = (overrides: Record<string, unknown> = {}) => ({
  amount: 5,
  assetCode: 'XLM',
  sellerPublicKey: seller.publicKey(),
  ...overrides,
});

describe('idempotency on the invoice write paths', () => {
  it('create: a retried submission returns the same invoice and creates no duplicate', async () => {
    const app = await startInvoiceApp();
    try {
      const headers = { ...walletAuth(seller.publicKey()), 'idempotency-key': KEY };
      const first = await post(app.baseUrl, '/invoices', createBody(), headers);
      const retry = await post(app.baseUrl, '/invoices', createBody(), headers);

      assert.equal(first.status, 201);
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');
      const [a, b] = [await first.json() as any, await retry.json() as any];
      assert.equal(b.data.invoice.id, a.data.invoice.id);
      assert.equal(b.data.invoice.memo, a.data.invoice.memo);
      assert.equal(b.data.qrCode, a.data.qrCode, 'the stored response includes the QR payload');
      assert.equal(app.raw.size(), 1);
    } finally {
      await app.close();
    }
  });

  it('create: without a key each submission still creates an invoice', async () => {
    const app = await startInvoiceApp();
    try {
      const headers = walletAuth(seller.publicKey());
      await post(app.baseUrl, '/invoices', createBody(), headers);
      await post(app.baseUrl, '/invoices', createBody(), headers);
      assert.equal(app.raw.size(), 2);
    } finally {
      await app.close();
    }
  });

  it('create: the same key with a different amount is a collision and creates nothing', async () => {
    const app = await startInvoiceApp();
    try {
      const headers = { ...walletAuth(seller.publicKey()), 'idempotency-key': KEY };
      await post(app.baseUrl, '/invoices', createBody({ amount: 5 }), headers);
      const collision = await post(app.baseUrl, '/invoices', createBody({ amount: 9 }), headers);

      assert.equal(collision.status, 422);
      assert.equal(((await collision.json()) as any).code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.equal(app.raw.size(), 1);
    } finally {
      await app.close();
    }
  });

  it('create: two sellers may use the same key string independently', async () => {
    const app = await startInvoiceApp();
    try {
      const a = await post(app.baseUrl, '/invoices', createBody(), {
        ...walletAuth(seller.publicKey()),
        'idempotency-key': KEY,
      });
      const b = await post(app.baseUrl, '/invoices', createBody({ sellerPublicKey: otherSeller.publicKey() }), {
        ...walletAuth(otherSeller.publicKey()),
        'idempotency-key': KEY,
      });
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.equal(b.headers.get('idempotent-replayed'), null);
      assert.equal(app.raw.size(), 2);
    } finally {
      await app.close();
    }
  });

  it('create: a seller cannot replay another seller\'s stored response with their key', async () => {
    const app = await startInvoiceApp();
    try {
      await post(app.baseUrl, '/invoices', createBody(), {
        ...walletAuth(seller.publicKey()),
        'idempotency-key': KEY,
      });
      // Same key and body from someone else is a different scope: it runs, and
      // then fails on ownership, rather than returning the first seller's invoice.
      const stolen = await post(app.baseUrl, '/invoices', createBody(), {
        ...walletAuth(otherSeller.publicKey()),
        'idempotency-key': KEY,
      });
      assert.equal(stolen.status, 403);
    } finally {
      await app.close();
    }
  });

  it('cancel: a retried cancel replays success instead of failing with INVALID_TRANSITION', async () => {
    const app = await startInvoiceApp();
    try {
      const created = await (await post(app.baseUrl, '/invoices', createBody(), walletAuth(seller.publicKey()))).json() as any;
      const id = created.data.invoice.id;
      const headers = { ...walletAuth(seller.publicKey()), 'idempotency-key': KEY };

      const first = await post(app.baseUrl, `/invoices/${id}/cancel`, {}, headers);
      const retry = await post(app.baseUrl, `/invoices/${id}/cancel`, {}, headers);
      assert.equal(first.status, 200);
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');

      // Without the key the same second cancel is correctly refused.
      const bare = await post(app.baseUrl, `/invoices/${id}/cancel`, {}, walletAuth(seller.publicKey()));
      assert.equal(bare.status, 400);
      assert.equal(((await bare.json()) as any).code, 'INVALID_TRANSITION');
    } finally {
      await app.close();
    }
  });

  it('cancel: a forbidden attempt releases the key so a corrected retry can run', async () => {
    const app = await startInvoiceApp();
    try {
      const created = await (await post(app.baseUrl, '/invoices', createBody(), walletAuth(seller.publicKey()))).json() as any;
      const id = created.data.invoice.id;
      const headers = { ...walletAuth(seller.publicKey()), 'idempotency-key': KEY };

      const wrong = await post(app.baseUrl, `/invoices/${id}/cancel`, { sellerPublicKey: otherSeller.publicKey() }, headers);
      assert.equal(wrong.status, 403);

      const corrected = await post(app.baseUrl, `/invoices/${id}/cancel`, {}, headers);
      assert.equal(corrected.status, 200);
      assert.equal(corrected.headers.get('idempotent-replayed'), null);
      assert.equal((await app.storage.getInvoiceById(id))?.status, 'CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('verify: a duplicate settles the invoice once and replays the result', async () => {
    let lookups = 0;
    const app = await startInvoiceApp({
      async getTransaction() {
        lookups += 1;
        return {
          transaction: { memo: memoOf },
          operations: [{ type: 'payment', from: PAYER, to: seller.publicKey(), amount: '5.0000000', asset_type: 'native' }],
        };
      },
    });
    let memoOf = '';
    try {
      const created = await (await post(app.baseUrl, '/invoices', createBody(), walletAuth(seller.publicKey()))).json() as any;
      const id = created.data.invoice.id;
      memoOf = created.data.invoice.memo;

      const headers = { 'idempotency-key': KEY };
      const first = await post(app.baseUrl, `/invoices/${id}/verify`, { txHash: TX }, headers);
      const retry = await post(app.baseUrl, `/invoices/${id}/verify`, { txHash: TX }, headers);

      assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');
      assert.equal(lookups, 1, 'the replay must not call Horizon again');
      assert.equal(((await retry.json()) as any).data.status, 'PAID');
    } finally {
      await app.close();
    }
  });

  it('verify: a lookup that failed is retried, not replayed (retry after failure)', async () => {
    let lookups = 0;
    let visible = false;
    let memoOf = '';
    const app = await startInvoiceApp({
      async getTransaction() {
        lookups += 1;
        if (!visible) throw new Error('not found');
        return {
          transaction: { memo: memoOf },
          operations: [{ type: 'payment', from: PAYER, to: seller.publicKey(), amount: '5.0000000', asset_type: 'native' }],
        };
      },
    });
    try {
      const created = await (await post(app.baseUrl, '/invoices', createBody(), walletAuth(seller.publicKey()))).json() as any;
      const id = created.data.invoice.id;
      memoOf = created.data.invoice.memo;
      const headers = { 'idempotency-key': KEY };

      const early = await post(app.baseUrl, `/invoices/${id}/verify`, { txHash: TX }, headers);
      assert.equal(early.status, 404);

      visible = true; // Horizon has now indexed the transaction
      const retry = await post(app.baseUrl, `/invoices/${id}/verify`, { txHash: TX }, headers);
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), null);
      assert.equal(lookups, 2);
    } finally {
      await app.close();
    }
  });

  it('simulate: a retried simulated payment is not applied twice', async () => {
    const app = await startInvoiceApp();
    try {
      const created = await (await post(app.baseUrl, '/invoices', createBody(), walletAuth(seller.publicKey()))).json() as any;
      const id = created.data.invoice.id;
      const headers = { ...maintainerAuth(), 'idempotency-key': KEY };

      const first = await post(app.baseUrl, `/invoices/${id}/simulate-payment`, {}, headers);
      const retry = await post(app.baseUrl, `/invoices/${id}/simulate-payment`, {}, headers);
      assert.equal(first.status, 200);
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');
      assert.equal(
        ((await first.json()) as any).data.paymentTxHash,
        ((await retry.json()) as any).data.paymentTxHash
      );
    } finally {
      await app.close();
    }
  });

  it('a replay is answered even after the invoice ceiling has since been reached', async () => {
    const raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createInvoiceRouter({
        storage,
        enableRateLimiting: false,
        enableConcurrencyLock: false,
        enableCeilingCheck: true,
        invoiceCeiling: 1,
      })
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      const headers = { ...walletAuth(seller.publicKey()), 'idempotency-key': KEY };
      assert.equal((await post(baseUrl, '/invoices', createBody(), headers)).status, 201);
      // The store is now full, so a genuinely new create is refused...
      assert.equal((await post(baseUrl, '/invoices', createBody({ amount: 7 }), walletAuth(seller.publicKey()))).status, 503);
      // ...but the client retrying the create that already succeeded still gets its answer.
      const retry = await post(baseUrl, '/invoices', createBody(), headers);
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
