/**
 * Feature-flag rollout guard with automatic rollback verification (#256).
 * Normal, failure, retry and authorization paths, plus the HTTP flow through the
 * real ops router.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { AdminConfigService } from '../src/config/admin-config';
import { featureFlagOverrides } from '../src/config/feature-flags';
import { auditStore, type AuditEvent } from '../src/audit/audit-service';
import { CapabilityTokenService } from '../src/security/capability-tokens';
import { createOpsRouter } from '../src/routes/ops.routes';
import { correlationMiddleware, MetricsRegistry } from '../src/observability/telemetry';
import {
  RolloutGuard,
  RolloutGuardError,
  metricsSignalSource,
  type SignalSample,
} from '../src/ops/rollout-guard';

const FLAG = 'paymentAmountTolerance';
const REASON = 'Stage tolerance on testnet before production';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function localOverrides() {
  const map = new Map<string, boolean>();
  return {
    get: (flag: string) => map.get(flag),
    set: (flag: string, value: boolean | null) => (value === null ? map.delete(flag) : map.set(flag, value)),
  } as typeof featureFlagOverrides;
}

function harness(opts: { env?: Record<string, string | undefined>; auditDown?: () => boolean; maxActive?: number } = {}) {
  let nowMs = T0;
  let sample: SignalSample = { total: 0, failures: 0 };
  let signalError: Error | null = null;
  const audit: Array<Omit<AuditEvent, 'id' | 'timestamp'>> = [];
  const overrides = localOverrides();
  const config = new AdminConfigService({
    overrides,
    env: opts.env ?? {},
    recordAudit: (event) => {
      if (opts.auditDown?.()) throw new Error('audit store down');
      audit.push(event);
      return { ...event, id: `evt-${audit.length}`, timestamp: new Date(nowMs).toISOString(), hash: `hash-${audit.length}` } as AuditEvent;
    },
  });
  let n = 0;
  const guard = new RolloutGuard({
    config,
    signals: () => {
      if (signalError) throw signalError;
      return { ...sample };
    },
    now: () => new Date(nowMs),
    newId: () => `r-${++n}`,
    maxActive: opts.maxActive,
  });
  return {
    guard,
    config,
    overrides,
    audit,
    advance: (ms: number) => (nowMs += ms),
    traffic: (total: number, failures: number) => (sample = { total: sample.total + total, failures: sample.failures + failures }),
    setSample: (s: SignalSample) => (sample = s),
    breakSignal: (err: Error | null) => (signalError = err),
  };
}

const START = { flag: FLAG, reason: REASON, actorId: 'maintainer-alice', capabilityId: 'cap-1' };
const flagState = (h: ReturnType<typeof harness>) => h.config.snapshot().featureFlags.find((f) => f.flag === FLAG)!;

async function rejects(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RolloutGuardError, `expected RolloutGuardError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, status);
    return true;
  });
}

describe('rollout guard — normal path', () => {
  it('enables the flag, watches a healthy window, then promotes', async () => {
    const h = harness();
    const started = await h.guard.start({ ...START, thresholds: { observationMs: 60_000, minSamples: 10 } });
    assert.equal(started.state, 'MONITORING');
    assert.equal(flagState(h).effective, true);
    assert.equal(flagState(h).source, 'override');
    assert.deepEqual(started.previous, { override: null, effective: false });
    assert.equal(h.audit.length, 1, 'the rollout itself has audit evidence');
    assert.match(h.audit[0].reason ?? '', /Rollout started/);

    h.traffic(50, 1);
    h.advance(30_000);
    assert.equal((await h.guard.evaluate(started.id)).state, 'MONITORING', 'still inside the window');

    h.traffic(50, 1);
    h.advance(31_000);
    const done = await h.guard.evaluate(started.id);
    assert.equal(done.state, 'PROMOTED');
    assert.equal(done.window.total, 100);
    assert.equal(done.window.failures, 2);
    assert.equal(done.needsAttention, false);
    assert.equal(flagState(h).effective, true, 'a promoted rollout keeps the flag on');
    assert.match(done.events.at(-1)!.detail, /FEATURE_PAYMENT_AMOUNT_TOLERANCE=true/);
  });

  it('measures only the rollout window, not traffic before it started', async () => {
    const h = harness();
    h.setSample({ total: 10_000, failures: 9_000 }); // an unhealthy past must not count
    const r = await h.guard.start({ ...START, thresholds: { observationMs: 1_000, minSamples: 5 } });
    h.traffic(10, 0);
    h.advance(2_000);
    const done = await h.guard.evaluate(r.id);
    assert.equal(done.state, 'PROMOTED');
    assert.deepEqual({ t: done.window.total, f: done.window.failures }, { t: 10, f: 0 });
  });
});

describe('rollout guard — automatic rollback and verification', () => {
  it('rolls back on a threshold breach and verifies the flag is back to its prior state', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { maxFailureRate: 0.1, minSamples: 10 } });
    h.traffic(40, 10); // 25% failures
    const rolled = await h.guard.evaluate(r.id);

    assert.equal(rolled.state, 'ROLLED_BACK');
    assert.equal(rolled.trigger, 'THRESHOLD_BREACH');
    assert.equal(rolled.needsAttention, false);
    assert.equal(rolled.rollbackVerification?.verified, true);
    assert.deepEqual(rolled.rollbackVerification?.problems, []);
    assert.equal(flagState(h).effective, false);
    assert.equal(flagState(h).source, 'environment', 'the override is cleared, not set to false');
    assert.equal(h.audit.length, 2, 'start and rollback each have evidence');
    assert.equal(h.audit[1].actor.id, 'rollout-guard');
    assert.match(h.audit[1].reason ?? '', /THRESHOLD_BREACH/);
  });

  it('restores a previously explicit override rather than clearing it', async () => {
    const h = harness();
    h.config.setFeatureFlag({ flag: FLAG, enabled: false, reason: 'Operator pinned this off earlier', expectedVersion: 0, actorId: 'm', capabilityId: 'c0' });
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1 } });
    assert.deepEqual(r.previous, { override: false, effective: false });
    h.traffic(10, 10);
    const rolled = await h.guard.evaluate(r.id);
    assert.equal(rolled.state, 'ROLLED_BACK');
    assert.equal(flagState(h).override, false);
  });

  it('does not roll back on failures until enough samples make the verdict trustworthy', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { maxFailureRate: 0.1, minSamples: 20 } });
    h.traffic(3, 3); // 100% of very little
    assert.equal((await h.guard.evaluate(r.id)).state, 'MONITORING');
    assert.equal(flagState(h).effective, true);
  });

  it('rolls back when the window ends without enough traffic to show health', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { observationMs: 1_000, minSamples: 20 } });
    h.traffic(2, 0);
    h.advance(5_000);
    const rolled = await h.guard.evaluate(r.id);
    assert.equal(rolled.state, 'ROLLED_BACK');
    assert.equal(rolled.trigger, 'INSUFFICIENT_SIGNAL');
    assert.equal(flagState(h).effective, false);
  });

  it('rolls back after the health signal is lost for maxSignalFailures readings in a row', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { maxSignalFailures: 2 } });
    h.breakSignal(new Error('metrics endpoint down'));
    const first = await h.guard.evaluate(r.id);
    assert.equal(first.state, 'MONITORING');
    assert.equal(first.signalFailures, 1);
    const second = await h.guard.evaluate(r.id);
    assert.equal(second.state, 'ROLLED_BACK');
    assert.equal(second.trigger, 'SIGNAL_LOST');
    assert.equal(flagState(h).effective, false);
  });

  it('a single good reading resets the lost-signal count', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { maxSignalFailures: 2 } });
    h.breakSignal(new Error('blip'));
    await h.guard.evaluate(r.id);
    h.breakSignal(null);
    assert.equal((await h.guard.evaluate(r.id)).signalFailures, 0);
    h.breakSignal(new Error('blip'));
    assert.equal((await h.guard.evaluate(r.id)).state, 'MONITORING');
  });

  it('re-bases the window when counters go backwards instead of reading a negative rate', async () => {
    const h = harness();
    h.setSample({ total: 500, failures: 5 });
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1 } });
    h.setSample({ total: 3, failures: 0 }); // process restarted
    const after = await h.guard.evaluate(r.id);
    assert.equal(after.state, 'MONITORING');
    assert.deepEqual(after.window, { total: 0, failures: 0, failureRate: 0 });
  });
});

describe('rollout guard — failure and retry paths', () => {
  it('failure: when the audit trail is down the flag is not changed and no rollout exists', async () => {
    const h = harness({ auditDown: () => true });
    await assert.rejects(h.guard.start(START), (e: { code?: string }) => e.code === 'CONFIG_AUDIT_UNAVAILABLE');
    assert.equal(flagState(h).effective, false);
    assert.equal(h.guard.list().length, 0);
  });

  it('failure: an unreadable baseline leaves the flag untouched', async () => {
    const h = harness();
    h.breakSignal(new Error('no metrics'));
    await rejects(h.guard.start(START), 'SIGNAL_UNAVAILABLE', 503);
    assert.equal(flagState(h).effective, false);
    assert.equal(h.audit.length, 0);
  });

  it('retry: a rollback blocked by an audit outage stays visibly pending, then completes and verifies', async () => {
    let down = false;
    const h = harness({ auditDown: () => down });
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 5, maxFailureRate: 0.1 } });
    down = true;
    h.traffic(20, 10);

    const pending = await h.guard.evaluate(r.id);
    assert.equal(pending.state, 'ROLLBACK_PENDING');
    assert.equal(pending.needsAttention, true);
    assert.match(pending.lastError ?? '', /Audit evidence could not be recorded/);
    assert.equal(flagState(h).effective, true, 'no change without evidence, so the flag is still on');
    assert.deepEqual(h.guard.needsAttention().map((x) => x.id), [r.id]);

    down = false;
    const retried = await h.guard.evaluate(r.id);
    assert.equal(retried.state, 'ROLLED_BACK');
    assert.equal(retried.needsAttention, false);
    assert.equal(retried.rollbackVerification?.verified, true);
    assert.equal(flagState(h).effective, false);
    assert.equal(h.guard.needsAttention().length, 0);
  });

  it('retry: a config version conflict during rollback is re-read and retried', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1, maxFailureRate: 0.1 } });
    // An unrelated config change lands between the guard reading the version and writing.
    const realSnapshot = h.config.snapshot.bind(h.config);
    let calls = 0;
    h.config.snapshot = () => {
      const snap = realSnapshot();
      if (++calls === 3) return { ...snap, version: snap.version - 1 }; // stale read once
      return snap;
    };
    h.traffic(10, 10);
    const rolled = await h.guard.evaluate(r.id);
    assert.equal(rolled.state, 'ROLLED_BACK');
    assert.ok(rolled.rollbackAttempts >= 2, `attempts=${rolled.rollbackAttempts}`);
  });

  it('failure: a rollback that does not restore the prior state is not reported as verified', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1, maxFailureRate: 0.1 } });
    const realSet = h.config.setFeatureFlag.bind(h.config);
    h.config.setFeatureFlag = (req) => {
      const result = realSet(req);
      if (req.enabled === null) h.overrides.set(FLAG, true); // something re-enables it behind the guard's back
      return result;
    };
    h.traffic(10, 10);
    const out = await h.guard.evaluate(r.id);
    assert.equal(out.state, 'ROLLBACK_PENDING');
    assert.equal(out.needsAttention, true);
    assert.equal(out.rollbackVerification?.verified, false);
    assert.match(out.rollbackVerification!.problems.join(' '), /override is true, expected null/);
  });

  it('retry: evaluating or rolling back a finished rollout changes nothing', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1, maxFailureRate: 0.1 } });
    h.traffic(10, 10);
    const first = await h.guard.evaluate(r.id);
    const auditCount = h.audit.length;
    const again = await h.guard.evaluate(r.id);
    const manual = await h.guard.rollback(r.id, { reason: 'Rolling back again to be safe', actorId: 'm', capabilityId: 'c' });
    assert.equal(again.state, 'ROLLED_BACK');
    assert.equal(manual.state, 'ROLLED_BACK');
    assert.equal(h.audit.length, auditCount);
    assert.equal(manual.finishedAt, first.finishedAt);
  });

  it('concurrent evaluations of one rollout roll back once', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1, maxFailureRate: 0.1 } });
    h.traffic(10, 10);
    const results = await Promise.all([h.guard.evaluate(r.id), h.guard.evaluate(r.id), h.guard.evaluate(r.id)]);
    assert.ok(results.every((x) => x.state === 'ROLLED_BACK'));
    assert.equal(h.audit.length, 2, 'one start and exactly one rollback');
  });
});

describe('rollout guard — manual rollback and authorization', () => {
  it('lets an operator roll back early, attributed to them', async () => {
    const h = harness();
    const r = await h.guard.start(START);
    const rolled = await h.guard.rollback(r.id, { reason: 'Support reports odd amounts', actorId: 'maintainer-bob', capabilityId: 'cap-9' });
    assert.equal(rolled.state, 'ROLLED_BACK');
    assert.equal(rolled.trigger, 'MANUAL');
    assert.equal(h.audit.at(-1)!.actor.id, 'maintainer-bob');
    assert.equal((h.audit.at(-1)!.metadata as any).capabilityId, 'cap-9');
  });

  it('requires an explanatory reason for a manual rollback', async () => {
    const h = harness();
    const r = await h.guard.start(START);
    await rejects(h.guard.rollback(r.id, { reason: 'no', actorId: 'm', capabilityId: 'c' }), 'INVALID_ROLLOUT', 400);
    assert.equal(flagState(h).effective, true);
  });

  it('refuses to roll back a promoted rollout through the guard', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { observationMs: 1_000, minSamples: 1 } });
    h.traffic(5, 0);
    h.advance(2_000);
    await h.guard.evaluate(r.id);
    await rejects(h.guard.rollback(r.id, { reason: 'Changed our mind later', actorId: 'm', capabilityId: 'c' }), 'ROLLOUT_FINISHED', 409);
  });

  it('never overwrites a flag someone else changed during monitoring', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1, maxFailureRate: 0.1 } });
    h.config.setFeatureFlag({ flag: FLAG, enabled: false, reason: 'Operator forced it off by hand', expectedVersion: h.config.snapshot().version, actorId: 'maintainer-carol', capabilityId: 'cap-x' });
    h.traffic(10, 10);
    const out = await h.guard.evaluate(r.id);
    assert.equal(out.state, 'SUPERSEDED');
    assert.equal(flagState(h).override, false, 'their decision stands');
    assert.equal(h.audit.length, 2, 'the guard wrote nothing of its own');
  });

  it('does not roll back over a different override set after the rollout began', async () => {
    const h = harness();
    const r = await h.guard.start({ ...START, thresholds: { minSamples: 1 } });
    h.overrides.set(FLAG, false);
    const out = await h.guard.rollback(r.id, { reason: 'Operator asked for a rollback', actorId: 'm', capabilityId: 'c' });
    assert.equal(out.state, 'SUPERSEDED');
    assert.equal(flagState(h).override, false);
  });
});

describe('rollout guard — scope and validation', () => {
  it('rejects unknown flags, short reasons and out-of-range thresholds', async () => {
    const h = harness();
    await rejects(h.guard.start({ ...START, flag: 'nope' }), 'UNKNOWN_FEATURE_FLAG', 404);
    await rejects(h.guard.start({ ...START, flag: '__proto__' }), 'UNKNOWN_FEATURE_FLAG', 404);
    await rejects(h.guard.start({ ...START, reason: 'short' }), 'INVALID_ROLLOUT', 400);
    await rejects(h.guard.start({ ...START, thresholds: { maxFailureRate: 2 } }), 'INVALID_ROLLOUT', 400);
    await rejects(h.guard.start({ ...START, thresholds: { observationMs: 5 } }), 'INVALID_ROLLOUT', 400);
    await rejects(h.guard.start({ ...START, thresholds: { minSamples: -1 } }), 'INVALID_ROLLOUT', 400);
    await rejects(h.guard.start({ ...START, thresholds: { maxSignalFailures: 0 } }), 'INVALID_ROLLOUT', 400);
    await rejects(h.guard.start({ ...START, scope: { operations: [] } }), 'INVALID_ROLLOUT', 400);
    assert.equal(flagState(h).effective, false, 'nothing was changed by a rejected start');
    assert.equal(h.audit.length, 0);
  });

  it('allows one active rollout per flag and reports a flag that is already on', async () => {
    const h = harness();
    await h.guard.start(START);
    await rejects(h.guard.start({ ...START, capabilityId: 'cap-2' }), 'ROLLOUT_ALREADY_ACTIVE', 409);

    const on = harness({ env: { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' } });
    await rejects(on.guard.start(START), 'NOTHING_TO_ROLL_OUT', 409);
  });

  it('caps concurrent active rollouts', async () => {
    const h = harness({ maxActive: 0 });
    await rejects(h.guard.start(START), 'TOO_MANY_ACTIVE_ROLLOUTS', 429);
  });

  it('allows a new rollout once the previous one has finished', async () => {
    const h = harness();
    const r = await h.guard.start(START);
    await h.guard.rollback(r.id, { reason: 'Abort the first attempt', actorId: 'm', capabilityId: 'c' });
    const second = await h.guard.start({ ...START, capabilityId: 'cap-2' });
    assert.equal(second.state, 'MONITORING');
    assert.equal(h.guard.list({ flag: FLAG }).length, 2);
  });

  it('reports unknown rollouts as 404', async () => {
    const h = harness();
    assert.throws(() => h.guard.inspect('missing'), (e: any) => e instanceof RolloutGuardError && e.httpStatus === 404);
    await assert.rejects(h.guard.evaluate('missing'), (e: any) => e.code === 'UNKNOWN_ROLLOUT');
  });

  it('returns copies, so callers cannot edit guard state', async () => {
    const h = harness();
    const r = await h.guard.start(START);
    r.state = 'PROMOTED';
    r.previous.override = true;
    assert.equal(h.guard.inspect(r.id).state, 'MONITORING');
    assert.equal(h.guard.inspect(r.id).previous.override, null);
  });
});

describe('metricsSignalSource', () => {
  it('sums operation counts and failures, optionally scoped to named operations', () => {
    const registry = {
      getMetricsSummary: () => ({
        operations: {
          verify: { count: 10, failures: 2 },
          create: { count: 5, failures: 0 },
        },
      }),
    } as unknown as MetricsRegistry;
    const source = metricsSignalSource(registry);
    assert.deepEqual(source({}), { total: 15, failures: 2 });
    assert.deepEqual(source({ operations: ['verify'] }), { total: 10, failures: 2 });
    assert.deepEqual(source({ operations: ['missing'] }), { total: 0, failures: 0 });
  });
});

describe('rollout guard over HTTP', () => {
  const ADMIN = 'rollout-guard-admin-token';
  const SECRET = 'rollout-guard-capability-secret-0123456';
  let server: Server;
  let base = '';
  let h: ReturnType<typeof harness>;
  let caps: CapabilityTokenService;

  before(async () => {
    h = harness();
    caps = new CapabilityTokenService({ secret: SECRET });
    const app = express();
    app.use(express.json());
    app.use(correlationMiddleware());
    app.use(
      '/api',
      createOpsRouter({
        storage: {} as never,
        adminToken: ADMIN,
        approvals: null,
        signedApprovals: null,
        capabilities: caps,
        adminConfig: h.config,
        rollouts: h.guard,
      })
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => auditStore.clear());

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, admin = true) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: (await res.json()) as any }));

  const mint = (action: string, target: string) => caps.issue({ action, target, subject: 'maintainer-alice' }).token;

  it('authorization: every rollout route needs the admin token; mutating routes also need a capability', async () => {
    for (const [method, path] of [
      ['GET', '/ops/rollouts'],
      ['POST', '/ops/rollouts'],
      ['POST', '/ops/rollouts/x/evaluate'],
      ['POST', '/ops/rollouts/x/rollback'],
    ]) {
      assert.equal((await call(method, path, method === 'GET' ? undefined : {}, {}, false)).status, 401, `${method} ${path}`);
    }
    const noCap = await call('POST', '/ops/rollouts', { flag: FLAG, reason: REASON });
    assert.equal(noCap.status, 401);
    assert.equal(noCap.body.code, 'CAPABILITY_REQUIRED');
    assert.equal(h.guard.list().length, 0);
  });

  it('authorization: a capability minted for another flag or action cannot start a rollout', async () => {
    const wrongTarget = await call('POST', '/ops/rollouts', { flag: FLAG, reason: REASON }, { 'x-capability-token': mint('rollout.start', 'someOtherFlag') });
    assert.ok([400, 401, 403].includes(wrongTarget.status), `got ${wrongTarget.status}`);
    const wrongAction = await call('POST', '/ops/rollouts', { flag: FLAG, reason: REASON }, { 'x-capability-token': mint('config.feature_flag.set', FLAG) });
    assert.ok([400, 401, 403].includes(wrongAction.status), `got ${wrongAction.status}`);
    assert.equal(h.guard.list().length, 0);
  });

  it('starts, evaluates into a rollback, and reports it as verified', async () => {
    const start = await call(
      'POST',
      '/ops/rollouts',
      { flag: FLAG, reason: REASON, thresholds: { minSamples: 5, maxFailureRate: 0.1 }, scope: { operations: ['verify'] } },
      { 'x-capability-token': mint('rollout.start', FLAG) }
    );
    assert.equal(start.status, 201);
    assert.equal(start.body.data.state, 'MONITORING');
    assert.equal(start.body.data.startedBy, 'maintainer-alice');
    const id = start.body.data.id;

    const listed = await call('GET', '/ops/rollouts?state=MONITORING');
    assert.equal(listed.body.data.rollouts.length, 1);

    h.traffic(20, 10);
    const evaluated = await call('POST', `/ops/rollouts/${id}/evaluate`);
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.body.data.state, 'ROLLED_BACK');
    assert.equal(evaluated.body.data.rollbackVerification.verified, true);

    const fetched = await call('GET', `/ops/rollouts/${id}`);
    assert.equal(fetched.body.data.state, 'ROLLED_BACK');
    assert.equal((await call('GET', '/ops/rollouts/unknown')).status, 404);
  });

  it('manual rollback with a capability, and the capability cannot be reused', async () => {
    const start = await call('POST', '/ops/rollouts', { flag: FLAG, reason: REASON }, { 'x-capability-token': mint('rollout.start', FLAG) });
    const id = start.body.data.id;
    const token = mint('rollout.rollback', id);
    const rolled = await call('POST', `/ops/rollouts/${id}/rollback`, { reason: 'Customer reports mismatched amounts' }, { 'x-capability-token': token });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.data.state, 'ROLLED_BACK');
    assert.equal(rolled.body.data.trigger, 'MANUAL');

    const replay = await call('POST', `/ops/rollouts/${id}/rollback`, { reason: 'Customer reports mismatched amounts' }, { 'x-capability-token': token });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, 'CAPABILITY_ALREADY_USED');
  });

  it('a failed start releases its capability so the same one can be retried', async () => {
    const token = mint('rollout.start', FLAG);
    const bad = await call('POST', '/ops/rollouts', { flag: FLAG, reason: 'short' }, { 'x-capability-token': token });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ROLLOUT');
    const ok = await call('POST', '/ops/rollouts', { flag: FLAG, reason: REASON }, { 'x-capability-token': token });
    assert.equal(ok.status, 201);
    await h.guard.rollback(ok.body.data.id, { reason: 'Cleanup after the HTTP test', actorId: 'm', capabilityId: 'c' });
  });
});
