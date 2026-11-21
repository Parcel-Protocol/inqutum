/**
 * User-facing status for degraded dependencies (#381).
 *
 * Covers the normal, failure, retry (cache / single-flight / stale) and
 * authorization (no operator detail leaks, public access) paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  evaluateDependency,
  runDependencyChecks,
  type DegradationReport,
  type DependencyId,
  type DependencyState,
  type ProbeResult,
} from '../src/ops/dependency-degradation';
import { FEATURE_LABELS, buildUserStatus, unknownUserStatus } from '../src/ops/user-status';
import { horizonProbe, postgresProbe } from '../src/ops/dependency-probes';
import { createStatusRouter } from '../src/routes/status.routes';

const T0 = new Date('2026-11-01T00:00:00.000Z');
const ALL: DependencyId[] = ['stellar_horizon', 'postgres', 'redis_queue', 'email_provider'];

function report(overrides: Partial<Record<DependencyId, ProbeResult | null>>): DegradationReport {
  const dependencies = ALL.map((id) => evaluateDependency(id, id in overrides ? overrides[id]! : { ok: true, latencyMs: 5 }));
  const rank: Record<DependencyState, number> = { healthy: 0, unknown: 1, degraded: 2, down: 3 };
  const overall = dependencies.reduce<DependencyState>((w, d) => (rank[d.state] > rank[w] ? d.state : w), 'healthy');
  return { generatedAt: T0.toISOString(), overall, dependencies };
}

const feature = (status: ReturnType<typeof buildUserStatus>, capability: string) => {
  const found = status.features.find((f) => f.capability === capability);
  assert.ok(found, `feature ${capability} present`);
  return found;
};

describe('buildUserStatus', () => {
  it('normal path: everything healthy is operational with no message', () => {
    const status = buildUserStatus(report({}));
    assert.equal(status.overall, 'operational');
    assert.equal(status.summary, 'All systems are operational.');
    assert.equal(status.generatedAt, T0.toISOString());
    for (const f of status.features) {
      assert.equal(f.state, 'operational');
      assert.equal(f.message, null);
      assert.equal(f.code, null);
      assert.equal(f.retryAfterSeconds, null);
      assert.equal(f.label, FEATURE_LABELS[f.capability]);
    }
  });

  it('lists every capability the matrix covers exactly once', () => {
    const status = buildUserStatus(report({}));
    const capabilities = status.features.map((f) => f.capability);
    assert.deepEqual([...capabilities].sort(), Object.keys(FEATURE_LABELS).sort());
    assert.equal(new Set(capabilities).size, capabilities.length);
  });

  it('failure path: a refuse fallback is unavailable with the matrix copy and retry hint', () => {
    const status = buildUserStatus(report({ postgres: { ok: false, error: 'ECONNREFUSED 10.0.0.5:5432' } }));
    assert.equal(status.overall, 'unavailable');
    const create = feature(status, 'invoice.create');
    assert.equal(create.state, 'unavailable');
    assert.equal(create.code, 'STORAGE_UNAVAILABLE');
    assert.equal(create.retryAfterSeconds, 15);
    assert.match(create.message ?? '', /Nothing was saved/);
    // Unrelated features stay operational.
    assert.equal(feature(status, 'job.enqueue').state, 'operational');
  });

  it('failure path: a defer fallback is degraded, not unavailable', () => {
    const status = buildUserStatus(report({ stellar_horizon: { ok: false, error: 'timeout' } }));
    assert.equal(status.overall, 'degraded');
    const verify = feature(status, 'payment.verify');
    assert.equal(verify.state, 'degraded');
    assert.equal(verify.code, 'VERIFICATION_DEFERRED');
    assert.match(verify.message ?? '', /Your invoice is unchanged/);
  });

  it('the most severe fallback wins when several dependencies are down', () => {
    // payment.verify is deferred by Horizon but refused by Postgres.
    const status = buildUserStatus(
      report({ stellar_horizon: { ok: false, error: 'timeout' }, postgres: { ok: false, error: 'ECONNREFUSED' } })
    );
    assert.equal(feature(status, 'payment.verify').state, 'unavailable');
    assert.equal(feature(status, 'payment.verify').code, 'STORAGE_UNAVAILABLE');
  });

  it('a slow but working dependency is degraded with a generic message and no retry', () => {
    const status = buildUserStatus(report({ postgres: { ok: true, latencyMs: 9000 } }));
    const read = feature(status, 'invoice.read');
    assert.equal(read.state, 'degraded');
    assert.equal(read.code, 'SLOW_RESPONSE');
    assert.equal(read.retryAfterSeconds, null);
    assert.equal(status.overall, 'degraded');
  });

  it('unprobed dependencies are unknown and never raise the overall state', () => {
    const status = buildUserStatus(report({ redis_queue: null }));
    assert.equal(feature(status, 'job.enqueue').state, 'unknown');
    // notification.send is also behind a probed (healthy) email provider.
    assert.equal(feature(status, 'notification.send').state, 'operational');
    assert.equal(status.overall, 'operational');
  });

  it('with no probe data at all the overall state is unknown, not operational', () => {
    const status = buildUserStatus(report({ stellar_horizon: null, postgres: null, redis_queue: null, email_provider: null }));
    assert.equal(status.overall, 'unknown');
    assert.equal(status.summary, 'Status is not available right now.');
    assert.equal(unknownUserStatus(T0).overall, 'unknown');
    assert.ok(unknownUserStatus(T0).features.every((f) => f.state === 'unknown'));
  });

  it('authorization path: no operator detail survives into the user status', () => {
    const seed = 'S' + 'A'.repeat(55);
    const status = buildUserStatus(
      report({
        postgres: { ok: false, latencyMs: 1234, error: `connect postgres://app:hunter2@db.internal:5432 failed ${seed}` },
        stellar_horizon: { ok: false, latencyMs: 4321, error: 'ETIMEDOUT horizon-testnet.stellar.org' },
      })
    );
    const wire = JSON.stringify(status);
    for (const leak of ['hunter2', 'db.internal', seed, 'horizon-testnet', 'ETIMEDOUT', 'ECONNREFUSED', '1234', '4321', 'runbook', 'DEPENDENCY-DEGRADATION', 'postgres', 'stellar_horizon', 'HORIZON_TIMEOUT', 'DB_UNREACHABLE']) {
      assert.ok(!wire.includes(leak), `status must not include ${leak}`);
    }
    assert.deepEqual(Object.keys(status).sort(), ['features', 'generatedAt', 'overall', 'summary']);
    for (const f of status.features) {
      assert.deepEqual(Object.keys(f).sort(), ['capability', 'code', 'label', 'message', 'retryAfterSeconds', 'state']);
    }
  });

  it('end to end with real probe results', async () => {
    const live = await runDependencyChecks(
      { postgres: async () => ({ ok: false, error: 'pool exhausted' }), stellar_horizon: async () => ({ ok: true, latencyMs: 20 }) },
      { now: () => T0, timeoutMs: 50 }
    );
    const status = buildUserStatus(live);
    assert.equal(feature(status, 'invoice.create').state, 'unavailable');
    assert.equal(feature(status, 'payment.verify').state, 'unavailable');
  });
});

describe('dependency probes', () => {
  it('horizonProbe: ok, non-2xx, thrown error and timeout', async () => {
    const ok = await horizonProbe('http://h', { fetchImpl: async () => ({ ok: true, status: 200 }) })();
    assert.equal(ok?.ok, true);

    const bad = await horizonProbe('http://h', { fetchImpl: async () => ({ ok: false, status: 503 }) })();
    assert.deepEqual({ ok: bad?.ok, error: bad?.error }, { ok: false, error: 'Horizon responded 503' });

    const thrown = await horizonProbe('http://h', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    })();
    assert.deepEqual({ ok: thrown?.ok, error: thrown?.error }, { ok: false, error: 'ECONNREFUSED' });

    const hung = await horizonProbe('http://h', {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    })();
    assert.deepEqual({ ok: hung?.ok, error: hung?.error }, { ok: false, error: 'timeout after 10ms' });
  });

  it('horizonProbe: non-Error rejections are stringified', async () => {
    const result = await horizonProbe('http://h', {
      fetchImpl: () => Promise.reject('boom'),
    })();
    assert.equal(result?.error, 'boom');
  });

  it('postgresProbe: ok and failure', async () => {
    assert.equal((await postgresProbe({ query: async () => ({}) })())?.ok, true);
    const down = await postgresProbe({
      query: async () => {
        throw new Error('too many clients');
      },
    })();
    assert.deepEqual({ ok: down?.ok, error: down?.error }, { ok: false, error: 'too many clients' });
    const odd = await postgresProbe({ query: () => Promise.reject('nope') })();
    assert.equal(odd?.error, 'nope');
  });
});

describe('GET /status', () => {
  async function serve(options: Parameters<typeof createStatusRouter>[0]) {
    const app = express();
    app.use('/api', createStatusRouter(options));
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/status`;
    return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('is public: answers 200 without credentials and sets cache headers', async () => {
    const app = await serve({ probes: { postgres: async () => ({ ok: true, latencyMs: 2 }) }, ttlMs: 5000 });
    try {
      const res = await fetch(app.base);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=5');
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.stale, false);
      assert.equal(feature(body.data, 'invoice.read').state, 'operational');
    } finally {
      await app.close();
    }
  });

  it('answers 200 with Retry-After when a feature is unavailable', async () => {
    const app = await serve({ probes: { postgres: async () => ({ ok: false, error: 'ECONNREFUSED' }) } });
    try {
      const res = await fetch(app.base);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('retry-after'), '15');
      assert.equal((await res.json()).data.overall, 'unavailable');
    } finally {
      await app.close();
    }
  });

  it('retry path: caches within the TTL and recomputes after it', async () => {
    let clock = T0.getTime();
    let runs = 0;
    const app = await serve({
      ttlMs: 1000,
      now: () => new Date(clock),
      probes: {
        postgres: async () => {
          runs += 1;
          return { ok: true, latencyMs: 1 };
        },
      },
    });
    try {
      await fetch(app.base);
      await fetch(app.base);
      assert.equal(runs, 1, 'second call served from cache');
      clock += 1000;
      await fetch(app.base);
      assert.equal(runs, 2, 'recomputed once the TTL elapsed');
    } finally {
      await app.close();
    }
  });

  it('shares one in-flight check between concurrent callers', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = await serve({
      ttlMs: 0,
      probes: {
        postgres: async () => {
          runs += 1;
          await gate;
          return { ok: true, latencyMs: 1 };
        },
      },
    });
    try {
      const calls = Promise.all([fetch(app.base), fetch(app.base), fetch(app.base)]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      const responses = await calls;
      assert.ok(responses.every((r) => r.status === 200));
      assert.equal(runs, 1);
    } finally {
      await app.close();
    }
  });

  it('serves the last good status flagged stale when the checks throw, unknown when there is none', async () => {
    let fail = false;
    let clock = T0.getTime();
    const good = report({ postgres: { ok: false, error: 'ECONNREFUSED' } });
    const app = await serve({
      ttlMs: 10,
      now: () => new Date(clock),
      runChecks: async () => {
        if (fail) throw new Error('probe runner exploded');
        return good;
      },
    });
    try {
      fail = true;
      const first = (await (await fetch(app.base)).json()).data;
      assert.equal(first.overall, 'unknown');
      assert.equal(first.stale, false);

      fail = false;
      clock += 100;
      assert.equal((await (await fetch(app.base)).json()).data.overall, 'unavailable');

      fail = true;
      clock += 100;
      const stale = (await (await fetch(app.base)).json()).data;
      assert.equal(stale.overall, 'unavailable');
      assert.equal(stale.stale, true);
      assert.ok(!JSON.stringify(stale).includes('exploded'));
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid ttl', () => {
    assert.throws(() => createStatusRouter({ ttlMs: -1 }), /ttlMs/);
    assert.throws(() => createStatusRouter({ ttlMs: 1.5 }), /ttlMs/);
  });

  it('with no probes configured reports unknown rather than healthy', async () => {
    const app = await serve({});
    try {
      assert.equal((await (await fetch(app.base)).json()).data.overall, 'unknown');
    } finally {
      await app.close();
    }
  });
});
