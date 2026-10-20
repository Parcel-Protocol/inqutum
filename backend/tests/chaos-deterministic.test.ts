/**
 * Deterministic chaos suite for interrupted user and background workflows (#232).
 *
 * Every scenario uses a fixed clock, fixed lease/retry dates, or a seeded PRNG.
 * There are no real sleeps and no wall-clock assertions, so the same seed and
 * inputs always produce the same trace and final state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeterministicReplayEngine,
  type SimulationEvent,
  type SimulatedResource,
} from '../src/concurrency/deterministic-replay-engine';
import {
  CheckpointInDoubtError,
  CheckpointInProgressError,
  MemoryCheckpointStore,
  runWithCheckpoint,
} from '../src/recovery/side-effect-checkpoint';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import type { Job } from '../src/jobs/job-types';

const T0 = new Date('2026-03-01T00:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function proofJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-proof-1',
    type: 'proof.export',
    payload: { version: 1, data: { invoiceId: 'inv-1' } },
    status: 'queued',
    attempts: 0,
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      backoffFactor: 2,
      maxDelayMs: 10_000,
    },
    runAt: T0.toISOString(),
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: 'proof:inv-1',
    correlationId: null,
    errors: [],
    result: null,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe('Deterministic chaos: interrupted email/proof side effects', () => {
  it('a crashed send becomes in_doubt and is never re-sent without reconciliation', async () => {
    const store = new MemoryCheckpointStore();
    // A previous process claimed the send but died before recording the outcome.
    await store.claim('email:inv-1', 'email.send', 'fp-1', T0, T0);

    let sends = 0;
    const options = {
      key: 'email:inv-1',
      effect: 'email.send',
      fingerprint: 'fp-1',
      now: () => at(10 * 60_000),
      staleAfterMs: 60_000,
    };

    await assert.rejects(
      runWithCheckpoint(store, options, async () => {
        sends += 1;
        return 'sent';
      }),
      CheckpointInDoubtError,
    );

    const checkpoint = await store.get('email:inv-1');
    assert.equal(checkpoint?.state, 'in_doubt');
    assert.equal(sends, 0, 'an unknown outcome must never be re-sent blindly');
  });

  it('reconciliation settles a crashed send without a duplicate provider call', async () => {
    const store = new MemoryCheckpointStore();
    await store.claim('email:inv-2', 'email.send', 'fp-2', T0, T0);

    let sends = 0;
    const result = await runWithCheckpoint(
      store,
      {
        key: 'email:inv-2',
        effect: 'email.send',
        fingerprint: 'fp-2',
        now: () => at(10 * 60_000),
        staleAfterMs: 60_000,
        reconcile: async () => ({
          done: true as const,
          result: { providerMessageId: 'prov-reconciled' },
        }),
      },
      async () => {
        sends += 1;
        return { providerMessageId: 'prov-new' };
      },
    );

    assert.deepEqual(result, { providerMessageId: 'prov-reconciled' });
    assert.equal(sends, 0);
    assert.equal((await store.get('email:inv-2'))?.state, 'succeeded');
  });

  it('a recorded failure allows exactly one deliberate retry', async () => {
    const store = new MemoryCheckpointStore();
    let attempts = 0;
    const options = { key: 'email:inv-3', effect: 'email.send', fingerprint: 'fp-3' };

    await assert.rejects(
      runWithCheckpoint(store, options, async () => {
        attempts += 1;
        throw new Error('provider 503');
      }),
      /provider 503/,
    );
    assert.equal((await store.get('email:inv-3'))?.state, 'failed');

    const result = await runWithCheckpoint(store, options, async () => {
      attempts += 1;
      return { providerMessageId: 'prov-retry' };
    });

    assert.deepEqual(result, { providerMessageId: 'prov-retry' });
    assert.equal(attempts, 2);
    assert.equal((await store.get('email:inv-3'))?.attempt, 2);
  });

  it('collapses a concurrent duplicate onto one in-flight send', async () => {
    const store = new MemoryCheckpointStore();
    let release!: (value: string) => void;
    const first = runWithCheckpoint(
      store,
      { key: 'email:inv-4', effect: 'email.send' },
      () => new Promise<string>((resolve) => (release = resolve)),
    );

    await assert.rejects(
      runWithCheckpoint(store, { key: 'email:inv-4', effect: 'email.send' }, async () => 'duplicate'),
      CheckpointInProgressError,
    );

    release('first');
    assert.equal(await first, 'first');
    assert.equal((await store.get('email:inv-4'))?.attempt, 1);
  });
});

describe('Deterministic chaos: interrupted background jobs', () => {
  it('reclaims an expired lease and fences the stale worker', async () => {
    const store = new MemoryJobStore();
    const enqueued = await store.enqueue(proofJob());
    assert.equal(enqueued.created, true);

    const workerA = await store.claimNext('worker-a', T0, 1_000, ['proof.export']);
    assert.equal(workerA?.lockedBy, 'worker-a');
    assert.equal(workerA?.attempts, 1);

    // worker-a dies without settling. Its lease expires at T0 + 1s.
    const workerB = await store.claimNext('worker-b', at(1_500), 1_000, ['proof.export']);
    assert.equal(workerB?.lockedBy, 'worker-b');
    assert.equal(workerB?.attempts, 2);

    // The stale worker cannot overwrite the newer claim.
    assert.equal(
      await store.markSucceeded('job-proof-1', 'worker-a', { proof: 'stale' }, at(1_600)),
      null,
    );

    const completed = await store.markSucceeded(
      'job-proof-1',
      'worker-b',
      { proof: 'fresh' },
      at(1_600),
    );
    assert.equal(completed?.status, 'succeeded');
    assert.deepEqual(completed?.result, { proof: 'fresh' });

    // A second success is fenced out; the job completes exactly once.
    assert.equal(
      await store.markSucceeded('job-proof-1', 'worker-b', { proof: 'again' }, at(1_700)),
      null,
    );
    const counts = await store.counts();
    assert.equal(counts.succeeded, 1);
    assert.equal(counts.running, 0);
  });

  it('honours a retry schedule without sleeping or wall-clock flakiness', async () => {
    const store = new MemoryJobStore();
    await store.enqueue(proofJob({ id: 'job-proof-2', idempotencyKey: 'proof:inv-2' }));

    const first = await store.claimNext('worker-a', T0, 1_000, ['proof.export']);
    assert.equal(first?.attempts, 1);

    const failed = await store.markFailed(
      'job-proof-2',
      'worker-a',
      { attempt: 1, at: T0.toISOString(), message: 'transient export timeout' },
      at(500),
      T0,
    );
    assert.equal(failed?.status, 'queued');
    assert.equal(failed?.runAt, at(500).toISOString());

    // Too early: the deterministic clock says the retry is not due yet.
    assert.equal(await store.claimNext('worker-b', at(100), 1_000, ['proof.export']), null);

    const retry = await store.claimNext('worker-b', at(500), 1_000, ['proof.export']);
    assert.equal(retry?.attempts, 2);
    const completed = await store.markSucceeded(
      'job-proof-2',
      'worker-b',
      { proof: 'retried' },
      at(600),
    );
    assert.equal(completed?.status, 'succeeded');
    assert.equal((await store.get('job-proof-2'))?.errors.length, 1);
  });

  it('dead-letters and requeues a job for operational recovery', async () => {
    const store = new MemoryJobStore();
    await store.enqueue(proofJob({ id: 'job-proof-3', idempotencyKey: 'proof:inv-3' }));

    await store.claimNext('worker-a', T0, 1_000, ['proof.export']);
    const dead = await store.markFailed(
      'job-proof-3',
      'worker-a',
      { attempt: 1, at: T0.toISOString(), message: 'permanent failure' },
      null,
      T0,
    );
    assert.equal(dead?.status, 'dead');

    const requeued = await store.requeueDead('job-proof-3', at(2_000));
    assert.equal(requeued?.status, 'queued');
    assert.equal(requeued?.attempts, 0);

    const reclaimed = await store.claimNext('worker-b', at(2_000), 1_000, ['proof.export']);
    assert.equal(reclaimed?.attempts, 1);
  });
});

describe('Deterministic chaos: stale reads and concurrent retries', () => {
  it('replays the same seeded interleaving and converges to the same state', async () => {
    const initial: SimulatedResource = {
      id: 'inv-chaos-1',
      version: 1,
      status: 'PENDING',
      fields: { description: 'initial', customerName: 'Alice' },
      settledAmount: 0,
    };

    const events: SimulationEvent[] = [
      {
        id: 'settle-network-drop',
        clientId: 'payer',
        role: 'OWNER',
        action: 'SETTLE_PAYMENT',
        value: 100,
        idempotencyKey: 'idem-chaos-settle',
        shouldFailNetwork: true,
      },
      {
        id: 'settle-retry',
        clientId: 'payer',
        role: 'OWNER',
        action: 'SETTLE_PAYMENT',
        value: 100,
        idempotencyKey: 'idem-chaos-settle',
      },
      {
        id: 'settle-duplicate',
        clientId: 'payer',
        role: 'OWNER',
        action: 'SETTLE_PAYMENT',
        value: 100,
        idempotencyKey: 'idem-chaos-settle',
      },
      {
        id: 'stale-cancel',
        clientId: 'seller',
        role: 'ADMIN',
        action: 'CANCEL_INVOICE',
        expectedVersion: 999,
      },
      {
        id: 'unauthorized-cancel',
        clientId: 'attacker',
        role: 'UNAUTHORIZED',
        action: 'CANCEL_INVOICE',
      },
      {
        id: 'legitimate-edit',
        clientId: 'owner',
        role: 'OWNER',
        action: 'UPDATE_FIELD',
        field: 'description',
        value: 'updated under chaos',
      },
    ];

    const run = async () => {
      const engine = new DeterministicReplayEngine(initial, 2026);
      return engine.executeConcurrentBatch(events);
    };

    const first = await run();
    const second = await run();

    assert.deepEqual(first.trace, second.trace, 'same seed must reproduce the exact trace');
    assert.deepEqual(first.finalState, second.finalState);
    assert.equal(first.finalState.status, 'PAID');
    assert.equal(first.finalState.settledAmount, 100);
    assert.equal(first.finalState.fields.description, 'updated under chaos');
    assert.equal(first.retriesHandled, 1);
    assert.equal(first.conflicts, 1);
    assert.ok(first.trace.some((step) => step.status === 'NETWORK_ERROR'));
    assert.ok(first.trace.some((step) => step.status === 'IDEMPOTENT_HIT'));
    assert.ok(first.trace.some((step) => step.status === 'UNAUTHORIZED'));
  });
});
