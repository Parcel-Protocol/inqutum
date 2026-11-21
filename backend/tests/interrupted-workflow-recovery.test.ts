/**
 * Deterministic recovery tests for interrupted workflows (#353).
 *
 * A workflow is "interrupted" when the process dies between two of its steps,
 * or in the middle of one. These tests do not sample such crashes: they
 * enumerate every crash point of a multi-step workflow, restart against the
 * same durable state, and assert the two properties recovery exists to give:
 *
 *   1. SAFETY    — an external side effect (an email, a payment proof) is never
 *                  performed twice, whatever the crash point.
 *   2. LIVENESS  — the workflow either completes, or stops at a named, explicit
 *                  state ("in doubt") that needs an operator. It never loops,
 *                  never skips a step, never silently re-sends.
 *
 * Everything is deterministic: time is an injected clock, "the process dies" is
 * a flag that makes the checkpoint store ignore writes, and there are no timers,
 * randomness or sleeps. Running the matrix twice yields identical traces.
 *
 * Covers the normal, failure, retry and authorization paths from the issue:
 * normal = no crash; failure = every crash point; retry = restart and resume;
 * authorization = a recovered run can never replay another workflow's result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markStepComplete,
  recoverOperation,
  startRecovery,
  type RecoveryCheckpoint,
  type RecoveryStep,
} from '../src/recovery/recovery-flow.ts';
import {
  CheckpointInDoubtError,
  CheckpointInProgressError,
  CheckpointKeyReusedError,
  MemoryCheckpointStore,
  fingerprintOf,
  runWithCheckpoint,
  type Checkpoint,
  type CheckpointState,
  type ClaimOutcome,
} from '../src/recovery/side-effect-checkpoint.ts';
import { MemoryJobStore } from '../src/jobs/memory-job-store.ts';
import { DEFAULT_RETRY_POLICY } from '../src/jobs/job-types.ts';
import { JobQueue, JobWorker } from '../src/jobs/worker.ts';
import { ExportCancelledError, ExportService } from '../src/exports/export-service.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';

// ---------------------------------------------------------------------------
// Deterministic world: durable state that survives a "crash", plus a clock.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const STALE_AFTER_MS = 5 * 60_000;
const silent = () => {};

class Crash extends Error {
  constructor(readonly point: string) {
    super(`process died at ${point}`);
    this.name = 'Crash';
  }
}

/** A checkpoint store whose writes stop landing the moment the process "dies". */
class MortalCheckpointStore extends MemoryCheckpointStore {
  alive = true;
  override async claim(...args: Parameters<MemoryCheckpointStore['claim']>): Promise<ClaimOutcome> {
    if (!this.alive) throw new Crash('claim after death');
    return super.claim(...args);
  }
  override async settle(
    key: string,
    attempt: number,
    state: Exclude<CheckpointState, 'started'>,
    outcome: { result?: unknown; error?: string },
    now: Date
  ): Promise<Checkpoint | null> {
    // A dead process cannot write its outcome down: that is the whole problem.
    if (!this.alive) return null;
    return super.settle(key, attempt, state, outcome, now);
  }
}

interface World {
  clock: number;
  store: MortalCheckpointStore;
  /** Durable cursor, as a Postgres row would be. Null until the first step. */
  cursor: RecoveryCheckpoint | null;
  /** What the outside world actually saw, in order. The ground truth. */
  ledger: string[];
  /** Ordered record of everything the driver did, for determinism checks. */
  trace: string[];
}

const newWorld = (): World => ({ clock: T0, store: new MortalCheckpointStore(), cursor: null, ledger: [], trace: [] });

const STEPS: RecoveryStep[] = [
  { name: 'validate' },
  { name: 'submit-proof', externalSideEffect: true },
  { name: 'notify-seller', externalSideEffect: true },
  { name: 'finalize' },
];

type Phase = 'before_step' | 'in_effect' | 'after_effect_recorded' | 'after_cursor';
interface CrashPoint {
  step: number;
  phase: Phase;
}

/** IN_PROGRESS: a claim that still looks live; retry later. IN_DOUBT: needs an operator. */
type Outcome = 'COMPLETE' | 'IN_DOUBT' | 'IN_PROGRESS' | 'CRASHED' | 'FAIL_SAFE';

interface RunOptions {
  crashAt?: CrashPoint;
  /** Lets a recovered run ask "did my previous attempt land?" (the provider's own log). */
  reconcile?: boolean;
  operationId?: string;
}

/** One process lifetime: resumes from the durable cursor until it finishes, stops, or dies. */
async function runProcess(world: World, options: RunOptions = {}): Promise<Outcome> {
  const op = options.operationId ?? 'op-1';
  const hit = (step: number, phase: Phase) => options.crashAt?.step === step && options.crashAt.phase === phase;
  world.store.alive = true;
  world.cursor ??= startRecovery(op);

  try {
    for (;;) {
      const decision = recoverOperation(STEPS, world.cursor);
      world.trace.push(`${decision.action}:${decision.nextStep?.name ?? '-'}`);
      if (decision.action === 'COMPLETE') return 'COMPLETE';
      if (decision.action === 'FAIL_SAFE') return 'FAIL_SAFE';

      const step = decision.nextStep!;
      const index = world.cursor.currentStep;
      if (hit(index, 'before_step')) throw new Crash(`${step.name}:before_step`);

      if (step.externalSideEffect) {
        const key = `${op}:${step.name}`;
        try {
          await runWithCheckpoint(
            world.store,
            {
              key,
              effect: step.name,
              fingerprint: fingerprintOf([op, step.name]),
              staleAfterMs: STALE_AFTER_MS,
              now: () => new Date(world.clock),
              log: silent,
              reconcile: options.reconcile
                ? async () => (world.ledger.includes(key) ? { done: true, result: { id: key } } : { done: false })
                : undefined,
            },
            async () => {
              world.ledger.push(key); // the provider accepted it
              world.trace.push(`effect:${key}`);
              if (hit(index, 'in_effect')) {
                world.store.alive = false; // dies before it can record the outcome
                throw new Crash(`${step.name}:in_effect`);
              }
              return { id: key };
            }
          );
        } catch (error) {
          if (error instanceof CheckpointInDoubtError) return 'IN_DOUBT';
          if (error instanceof CheckpointInProgressError) return 'IN_PROGRESS';
          throw error;
        }
        if (hit(index, 'after_effect_recorded')) throw new Crash(`${step.name}:after_effect_recorded`);
      } else {
        world.trace.push(`run:${step.name}`);
      }

      world.cursor = markStepComplete(world.cursor, step);
      if (hit(index, 'after_cursor')) throw new Crash(`${step.name}:after_cursor`);
    }
  } catch (error) {
    if (error instanceof Crash) return 'CRASHED';
    throw error;
  }
}

/** Crash, let the stale window pass, restart once, and report. */
async function crashThenRecover(crashAt: CrashPoint, reconcile: boolean) {
  const world = newWorld();
  const first = await runProcess(world, { crashAt });
  world.clock += STALE_AFTER_MS + 1_000; // the dead run's claim is now provably stale
  const second = await runProcess(world, { reconcile });
  return { world, first, second };
}

const effectCount = (world: World, key: string) => world.ledger.filter((entry) => entry === key).length;

const CRASH_POINTS: CrashPoint[] = STEPS.flatMap((step, index) =>
  (['before_step', 'in_effect', 'after_effect_recorded', 'after_cursor'] as Phase[])
    // A step with no external effect has no "in effect" window to crash inside.
    .filter((phase) => step.externalSideEffect || (phase !== 'in_effect' && phase !== 'after_effect_recorded'))
    .map((phase) => ({ step: index, phase }))
);

// ---------------------------------------------------------------------------

describe('interrupted workflow recovery: crash-point matrix', () => {
  it('normal path: with no crash every step runs once, in order, and each effect happens once', async () => {
    const world = newWorld();
    assert.equal(await runProcess(world), 'COMPLETE');
    assert.deepEqual(world.ledger, ['op-1:submit-proof', 'op-1:notify-seller']);
    assert.equal(world.cursor?.currentStep, STEPS.length);
    assert.deepEqual(world.cursor?.completedEffects, ['submit-proof', 'notify-seller']);
  });

  it('enumerates every crash point (guards against the matrix silently shrinking)', () => {
    // 2 plain steps x 2 phases + 2 effect steps x 4 phases.
    assert.equal(CRASH_POINTS.length, 12);
  });

  for (const crashAt of CRASH_POINTS) {
    const label = `${STEPS[crashAt.step].name} / ${crashAt.phase}`;

    it(`failure + retry, no provider lookup: crash at ${label} never duplicates an effect`, async () => {
      const { world, first, second } = await crashThenRecover(crashAt, false);
      assert.equal(first, 'CRASHED');

      for (const step of STEPS.filter((s) => s.externalSideEffect)) {
        assert.ok(effectCount(world, `op-1:${step.name}`) <= 1, `${step.name} performed more than once`);
      }

      const unknownOutcome = crashAt.phase === 'in_effect';
      if (unknownOutcome) {
        // The effect may or may not have landed and nothing can tell. Stop, loudly.
        assert.equal(second, 'IN_DOUBT');
        assert.notEqual(world.cursor?.currentStep, STEPS.length, 'must not report completion');
        const later = STEPS.slice(crashAt.step + 1).map((s) => `run:${s.name}`);
        for (const entry of later) assert.ok(!world.trace.includes(entry), `${entry} ran past an in-doubt step`);
      } else {
        assert.equal(second, 'COMPLETE');
        assert.deepEqual(world.ledger, ['op-1:submit-proof', 'op-1:notify-seller'], 'each effect exactly once');
      }
    });

    it(`failure + retry, with provider lookup: crash at ${label} always completes exactly once`, async () => {
      const { world, first, second } = await crashThenRecover(crashAt, true);
      assert.equal(first, 'CRASHED');
      assert.equal(second, 'COMPLETE');
      assert.deepEqual(world.ledger, ['op-1:submit-proof', 'op-1:notify-seller']);
      assert.equal(world.cursor?.currentStep, STEPS.length);
    });
  }

  it('a restart before the stale window does not take over a live-looking claim', async () => {
    const world = newWorld();
    assert.equal(await runProcess(world, { crashAt: { step: 1, phase: 'in_effect' } }), 'CRASHED');
    world.clock += STALE_AFTER_MS - 1_000; // not stale yet: it might still be running
    assert.equal(await runProcess(world), 'IN_PROGRESS', 'refused, not re-run');
    world.clock += 2_000; // now past the stale window
    assert.equal(await runProcess(world), 'IN_DOUBT', 'and only then declared in doubt');
    assert.equal(effectCount(world, 'op-1:submit-proof'), 1);
  });

  it('recovery is idempotent: restarting a finished workflow does nothing', async () => {
    const world = newWorld();
    await runProcess(world);
    const before = [...world.ledger];
    for (let i = 0; i < 3; i += 1) assert.equal(await runProcess(world), 'COMPLETE');
    assert.deepEqual(world.ledger, before);
  });

  it('survives repeated crashes: dying on every restart still ends with exactly-once effects', async () => {
    const world = newWorld();
    const order: CrashPoint[] = [
      { step: 1, phase: 'in_effect' },
      { step: 1, phase: 'after_effect_recorded' },
      { step: 2, phase: 'before_step' },
      { step: 2, phase: 'in_effect' },
      { step: 3, phase: 'after_cursor' },
    ];
    for (const crashAt of order) {
      await runProcess(world, { crashAt, reconcile: true });
      world.clock += STALE_AFTER_MS + 1_000;
    }
    assert.equal(await runProcess(world, { reconcile: true }), 'COMPLETE');
    assert.deepEqual(world.ledger, ['op-1:submit-proof', 'op-1:notify-seller']);
  });

  it('is deterministic: the same crash point replays to an identical trace and ledger', async () => {
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const crashAt of CRASH_POINTS) {
        for (const reconcile of [false, true]) {
          const { world, first, second } = await crashThenRecover(crashAt, reconcile);
          out[`${crashAt.step}/${crashAt.phase}/${reconcile}`] = { first, second, trace: world.trace, ledger: world.ledger, cursor: world.cursor };
        }
      }
      return JSON.stringify(out);
    };
    assert.equal(await snapshot(), await snapshot());
  });

  it('authorization path: a recovered run cannot replay another operation\'s result', async () => {
    const world = newWorld();
    await runProcess(world, { operationId: 'op-A' });

    // Same step name, different operation id: its own key, so it performs its own effect.
    world.cursor = null;
    await runProcess(world, { operationId: 'op-B' });
    assert.deepEqual(world.ledger, ['op-A:submit-proof', 'op-A:notify-seller', 'op-B:submit-proof', 'op-B:notify-seller']);

    // And a key reused with another payload is refused rather than answered with A's result.
    await assert.rejects(
      runWithCheckpoint(
        world.store,
        { key: 'op-A:submit-proof', effect: 'submit-proof', fingerprint: fingerprintOf(['op-A', 'a-different-payload']), now: () => new Date(world.clock), log: silent },
        async () => ({ id: 'stolen' })
      ),
      CheckpointKeyReusedError
    );
    assert.equal(effectCount(world, 'op-A:submit-proof'), 1);
  });
});

describe('interrupted workflow recovery: cursor edge cases', () => {
  it('a FAILED checkpoint is never resumed', () => {
    const failed: RecoveryCheckpoint = { ...startRecovery('op'), state: 'FAILED', message: 'operator marked failed' };
    assert.deepEqual(recoverOperation(STEPS, failed), { action: 'FAIL_SAFE', message: 'operator marked failed' });
  });

  it('a cursor at or past the end is complete; an empty workflow is complete immediately', () => {
    assert.equal(recoverOperation(STEPS, { ...startRecovery('op'), currentStep: STEPS.length }).action, 'COMPLETE');
    assert.equal(recoverOperation(STEPS, { ...startRecovery('op'), currentStep: STEPS.length + 5 }).action, 'COMPLETE');
    assert.equal(recoverOperation([], startRecovery('op')).action, 'COMPLETE');
  });

  it('a rewound cursor may re-run a plain step but fails safe on a recorded effect', () => {
    const atNotify = [...STEPS.keys()].reduce<RecoveryCheckpoint>(
      (cp, i) => (i < 2 ? markStepComplete(cp, STEPS[i]) : cp),
      startRecovery('op')
    );
    assert.equal(atNotify.currentStep, 2);
    assert.deepEqual(atNotify.completedEffects, ['submit-proof']);

    assert.equal(recoverOperation(STEPS, { ...atNotify, currentStep: 0 }).action, 'RESUME', 'validate is safe to repeat');
    const rewound = recoverOperation(STEPS, { ...atNotify, currentStep: 1 });
    assert.equal(rewound.action, 'FAIL_SAFE');
    assert.match(rewound.message, /manual verification/);
  });

  it('marking an effect complete twice records it once and advances by one each call', () => {
    const once = markStepComplete(startRecovery('op'), STEPS[1]);
    const twice = markStepComplete({ ...once, currentStep: 1 }, STEPS[1]);
    assert.deepEqual(twice.completedEffects, ['submit-proof']);
    assert.equal(twice.currentStep, 2);
  });

  it('checkpoints are values: advancing never mutates the previous one', () => {
    const start = startRecovery('op');
    const frozen = JSON.stringify(start);
    markStepComplete(start, STEPS[1]);
    assert.equal(JSON.stringify(start), frozen);
  });
});

describe('interrupted workflow recovery: background job lease expiry', () => {
  it('a worker that dies mid-job is replaced after the lease and the effect still happens once', async () => {
    const LEASE_MS = 60_000;
    let clock = T0;
    const store = new MemoryJobStore();
    const checkpoints = new MortalCheckpointStore();
    const ledger: string[] = [];
    const queue = new JobQueue(store, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, () => new Date(clock));

    const handler = (die: boolean) => async (_payload: unknown, ctx: { idempotencyKey: string; attempt: number }) =>
      runWithCheckpoint(
        checkpoints,
        {
          key: `job:${ctx.idempotencyKey}`,
          effect: 'send-proof',
          staleAfterMs: LEASE_MS,
          now: () => new Date(clock),
          log: silent,
          reconcile: async () => (ledger.includes(ctx.idempotencyKey) ? { done: true, result: { sent: true } } : { done: false }),
        },
        async () => {
          ledger.push(ctx.idempotencyKey);
          if (die) {
            checkpoints.alive = false;
            throw new Crash('worker-1 died after sending');
          }
          return { sent: true };
        }
      );

    const { job } = await queue.enqueue('send-proof', {}, { idempotencyKey: 'proof-42' });

    // Worker 1 claims the job and dies mid-effect. A dead process never calls markFailed.
    const claimed = await store.claimNext('worker-1', new Date(clock), LEASE_MS, ['send-proof']);
    assert.equal(claimed?.id, job.id);
    await assert.rejects(handler(true)(claimed!.payload, { idempotencyKey: 'proof-42', attempt: claimed!.attempts }), Crash);
    assert.equal((await store.get(job.id))?.status, 'running', 'still leased to the dead worker');

    // Before the lease runs out nobody else may take it.
    checkpoints.alive = true;
    const worker2 = new JobWorker({ store, workerId: 'worker-2', leaseMs: LEASE_MS, now: () => new Date(clock), log: silent });
    worker2.register('send-proof', handler(false));
    assert.equal(await worker2.runOnce(), null);

    // After it, worker 2 reclaims, reconciles against the provider, and finishes without resending.
    clock += LEASE_MS + STALE_AFTER_MS;
    const done = await worker2.runOnce();
    assert.equal(done?.status, 'succeeded');
    assert.equal(done?.attempts, 2);
    assert.deepEqual(ledger, ['proof-42']);
    assert.deepEqual(done?.result, { sent: true });
  });
});

describe('interrupted workflow recovery: interrupted export', () => {
  const SELLER = 'G' + 'A'.repeat(55);

  it('an export aborted between pages persists nothing and a retry produces the complete file', async () => {
    memoryStorage.clear();
    const storage = new MemoryInvoiceStorage();
    for (let i = 0; i < 7; i += 1) {
      await storage.createInvoice({ amount: 1 + i, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7 } as never);
    }
    const clock = new Date('2026-11-01T00:00:00.000Z');
    const service = () => new ExportService(storage, { now: () => clock, pageSize: 3 });

    const baseline = JSON.parse((await service().create(SELLER, { format: 'json' })).body);
    assert.equal(baseline.recordCount, 7);

    // Interrupt after the first page has been read.
    const controller = new AbortController();
    const realFetch = storage.getInvoicesBySeller.bind(storage);
    let pages = 0;
    storage.getInvoicesBySeller = (async (...args: Parameters<typeof realFetch>) => {
      const page = await realFetch(...args);
      pages += 1;
      if (pages === 1) controller.abort();
      return page;
    }) as typeof storage.getInvoicesBySeller;

    const interrupted = service();
    await assert.rejects(interrupted.create(SELLER, { format: 'json' }, SELLER, controller.signal), ExportCancelledError);
    assert.equal(interrupted.size(), 0, 'no partial artifact was stored');
    assert.equal(pages, 1, 'stopped at the page boundary instead of reading on');

    // Retry against the same storage: complete, and identical to the uninterrupted export.
    storage.getInvoicesBySeller = realFetch as typeof storage.getInvoicesBySeller;
    const retried = JSON.parse((await interrupted.create(SELLER, { format: 'json' })).body);
    const strip = ({ exportId: _id, ...rest }: Record<string, unknown>) => rest;
    assert.deepEqual(strip(retried), strip(baseline));
    assert.equal(interrupted.size(), 1);
  });
});
