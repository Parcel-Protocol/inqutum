/**
 * Feature-flag rollout guard with automatic rollback verification (#256).
 *
 * A rollout turns one risky feature flag on (a runtime override applied through
 * the audited AdminConfigService), watches a health signal for a bounded window,
 * and then either promotes it (healthy) or rolls it back (unhealthy). A rollback
 * is not trusted until it has been verified: the guard re-reads the flag and
 * confirms it is back to what it was before the rollout.
 *
 *   MONITORING --healthy window--------> PROMOTED
 *   MONITORING --breach / lost signal--> ROLLBACK_PENDING --verified--> ROLLED_BACK
 *   MONITORING --flag changed by hand--> SUPERSEDED   (guard never overwrites)
 *
 * Invariants:
 *  - Scoped: one flag per rollout, one active rollout per flag, a bounded number
 *    of active rollouts, thresholds and a fixed observation window.
 *  - Fail safe: if the baseline cannot be sampled the flag is not touched. If the
 *    signal is lost while monitoring, or the window ends without enough traffic
 *    to prove health, the guard rolls back instead of assuming all is well.
 *  - No inconsistent state: ROLLBACK_PENDING is a visible, retryable state (for
 *    example when the audit trail is down and AdminConfigService refuses the
 *    change). The flag stays as it is until the rollback succeeds and verifies.
 *  - No clobbering: if someone else changed the override while monitoring, the
 *    guard stops (SUPERSEDED) rather than reverting their decision.
 *  - Idempotent: evaluating or rolling back a finished rollout changes nothing.
 *  - Attribution: every change goes through AdminConfigService, so each start and
 *    rollback has hash-chained audit evidence and a config version.
 *
 * Rollouts are process-local, like the overrides they manage; a restart clears
 * both and the environment value applies again. See docs/ROLLOUT_GUARD.md.
 */
import { randomUUID } from 'crypto';
import { AdminConfigError, type AdminConfigService, type FeatureFlagState } from '../config/admin-config';
import { FEATURE_FLAGS, type FeatureFlag } from '../config/feature-flags';
import type { MetricsRegistry } from '../observability/telemetry';

export type RolloutState = 'MONITORING' | 'PROMOTED' | 'ROLLED_BACK' | 'ROLLBACK_PENDING' | 'SUPERSEDED';

export type RolloutTrigger = 'THRESHOLD_BREACH' | 'SIGNAL_LOST' | 'INSUFFICIENT_SIGNAL' | 'MANUAL';

export type RolloutGuardErrorCode =
  | 'INVALID_ROLLOUT'
  | 'UNKNOWN_FEATURE_FLAG'
  | 'UNKNOWN_ROLLOUT'
  | 'NOTHING_TO_ROLL_OUT'
  | 'ROLLOUT_ALREADY_ACTIVE'
  | 'TOO_MANY_ACTIVE_ROLLOUTS'
  | 'ROLLOUT_FINISHED'
  | 'SIGNAL_UNAVAILABLE';

const HTTP_STATUS: Record<RolloutGuardErrorCode, number> = {
  INVALID_ROLLOUT: 400,
  UNKNOWN_FEATURE_FLAG: 404,
  UNKNOWN_ROLLOUT: 404,
  NOTHING_TO_ROLL_OUT: 409,
  ROLLOUT_ALREADY_ACTIVE: 409,
  TOO_MANY_ACTIVE_ROLLOUTS: 429,
  ROLLOUT_FINISHED: 409,
  SIGNAL_UNAVAILABLE: 503,
};

export class RolloutGuardError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: RolloutGuardErrorCode, message: string) {
    super(message);
    this.name = 'RolloutGuardError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** Cumulative counters. The guard compares two samples, so absolute values do not matter. */
export interface SignalSample {
  total: number;
  failures: number;
}

export interface SignalScope {
  /** Operation names to watch; all operations when omitted. */
  operations?: string[];
}

export type SignalSource = (scope: SignalScope) => SignalSample | Promise<SignalSample>;

export interface RolloutThresholds {
  /** Roll back when failures / total in the window exceeds this (0..1). */
  maxFailureRate: number;
  /** Observations needed before a verdict is trusted. */
  minSamples: number;
  /** How long to watch before promoting. */
  observationMs: number;
  /** Consecutive unreadable samples tolerated before rolling back. */
  maxSignalFailures: number;
}

export const DEFAULT_THRESHOLDS: RolloutThresholds = {
  maxFailureRate: 0.05,
  minSamples: 20,
  observationMs: 15 * 60_000,
  maxSignalFailures: 3,
};

export interface RollbackVerification {
  verified: boolean;
  checkedAt: string;
  /** Effective value of the flag when checked. */
  effective: boolean;
  source: 'override' | 'environment';
  expectedEffective: boolean;
  problems: string[];
}

export interface RolloutEvent {
  at: string;
  type: 'STARTED' | 'SAMPLED' | 'SIGNAL_ERROR' | 'ROLLBACK_ATTEMPT' | 'ROLLBACK_FAILED' | 'ROLLED_BACK' | 'PROMOTED' | 'SUPERSEDED';
  detail: string;
}

export interface RolloutRecord {
  id: string;
  flag: FeatureFlag;
  state: RolloutState;
  reason: string;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  thresholds: RolloutThresholds;
  scope: SignalScope;
  /** Flag state before the rollout; a rollback restores exactly this. */
  previous: { override: boolean | null; effective: boolean };
  /** Config version produced by the rollout's own change. */
  appliedConfigVersion: number;
  baseline: SignalSample;
  /** Latest window counters (current sample minus baseline). */
  window: { total: number; failures: number; failureRate: number };
  signalFailures: number;
  trigger: RolloutTrigger | null;
  rollbackAttempts: number;
  rollbackVerification: RollbackVerification | null;
  lastError: string | null;
  /** True while a person needs to act (rollback not yet verified). */
  needsAttention: boolean;
  events: RolloutEvent[];
}

export interface StartRolloutRequest {
  flag: string;
  reason: unknown;
  actorId: string;
  capabilityId: string;
  correlationId?: string;
  thresholds?: Partial<RolloutThresholds>;
  scope?: SignalScope;
}

export interface RollbackRequest {
  reason: unknown;
  actorId: string;
  capabilityId: string;
  correlationId?: string;
}

export interface RolloutGuardOptions {
  config: Pick<AdminConfigService, 'snapshot' | 'setFeatureFlag'>;
  signals: SignalSource;
  now?: () => Date;
  newId?: () => string;
  /** Concurrent active rollouts allowed (blast-radius cap). */
  maxActive?: number;
  /** Finished rollouts kept for inspection; oldest are dropped first. */
  maxHistory?: number;
}

const GUARD_ACTOR = 'rollout-guard';
const MIN_REASON = 10;
const MAX_REASON = 500;
const MAX_ROLLBACK_TRIES = 3;
const MAX_EVENTS = 100;

const isFlag = (flag: string): flag is FeatureFlag => Object.hasOwn(FEATURE_FLAGS, flag);
const isActive = (state: RolloutState) => state === 'MONITORING' || state === 'ROLLBACK_PENDING';
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function validateThresholds(input: Partial<RolloutThresholds> | undefined): RolloutThresholds {
  const t = { ...DEFAULT_THRESHOLDS, ...(input ?? {}) };
  const bad = (msg: string) => new RolloutGuardError('INVALID_ROLLOUT', msg);
  if (!(typeof t.maxFailureRate === 'number' && t.maxFailureRate >= 0 && t.maxFailureRate <= 1)) {
    throw bad('maxFailureRate must be a number between 0 and 1');
  }
  if (!Number.isSafeInteger(t.minSamples) || t.minSamples < 0) throw bad('minSamples must be a non-negative integer');
  if (!Number.isSafeInteger(t.observationMs) || t.observationMs < 1_000 || t.observationMs > 24 * 3_600_000) {
    throw bad('observationMs must be between 1000 and 86400000');
  }
  if (!Number.isSafeInteger(t.maxSignalFailures) || t.maxSignalFailures < 1 || t.maxSignalFailures > 100) {
    throw bad('maxSignalFailures must be an integer between 1 and 100');
  }
  return t;
}

function validateScope(scope: SignalScope | undefined): SignalScope {
  if (scope === undefined) return {};
  const ops = scope.operations;
  if (ops === undefined) return {};
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 20 || ops.some((o) => typeof o !== 'string' || !o || o.length > 80)) {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'scope.operations must be 1-20 operation names');
  }
  return { operations: [...new Set(ops)] };
}

/** Signal source backed by the process metrics registry (operation counts and failures). */
export function metricsSignalSource(registry: Pick<MetricsRegistry, 'getMetricsSummary'>): SignalSource {
  return (scope) => {
    const operations = registry.getMetricsSummary().operations as Record<string, { count: number; failures: number }>;
    const wanted = scope.operations ? new Set(scope.operations) : null;
    let total = 0;
    let failures = 0;
    for (const [name, stats] of Object.entries(operations)) {
      if (wanted && !wanted.has(name)) continue;
      total += stats.count;
      failures += stats.failures;
    }
    return { total, failures };
  };
}

export class RolloutGuard {
  private readonly rollouts = new Map<string, RolloutRecord>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxActive: number;
  private readonly maxHistory: number;

  constructor(private readonly options: RolloutGuardOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.maxActive = options.maxActive ?? 5;
    this.maxHistory = options.maxHistory ?? 200;
  }

  /** Runs `task` after any earlier task on the same key, so one rollout never has two writers. */
  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  private flagState(flag: FeatureFlag): FeatureFlagState {
    return this.options.config.snapshot().featureFlags.find((f) => f.flag === flag)!;
  }

  private event(rollout: RolloutRecord, type: RolloutEvent['type'], detail: string) {
    rollout.events.push({ at: this.now().toISOString(), type, detail });
    if (rollout.events.length > MAX_EVENTS) rollout.events.splice(0, rollout.events.length - MAX_EVENTS);
  }

  private view(rollout: RolloutRecord): RolloutRecord {
    return structuredClone(rollout);
  }

  private get(id: string): RolloutRecord {
    const rollout = this.rollouts.get(id);
    if (!rollout) throw new RolloutGuardError('UNKNOWN_ROLLOUT', 'Rollout not found');
    return rollout;
  }

  list(filter: { state?: RolloutState; flag?: string } = {}): RolloutRecord[] {
    return [...this.rollouts.values()]
      .filter((r) => (!filter.state || r.state === filter.state) && (!filter.flag || r.flag === filter.flag))
      .map((r) => this.view(r));
  }

  inspect(id: string): RolloutRecord {
    return this.view(this.get(id));
  }

  /** Rollouts a person must look at: a rollback that has not verified. */
  needsAttention(): RolloutRecord[] {
    return this.list().filter((r) => r.needsAttention);
  }

  private prune() {
    if (this.rollouts.size <= this.maxHistory) return;
    for (const [id, r] of this.rollouts) {
      if (this.rollouts.size <= this.maxHistory) break;
      if (!isActive(r.state)) this.rollouts.delete(id);
    }
  }

  /**
   * Turn the flag on and start watching. Nothing is changed unless the baseline
   * sample succeeds and the audited config change is accepted.
   */
  async start(request: StartRolloutRequest): Promise<RolloutRecord> {
    if (!isFlag(request.flag)) throw new RolloutGuardError('UNKNOWN_FEATURE_FLAG', `Unknown feature flag "${request.flag}"`);
    const flag = request.flag;
    return this.serialize(`flag:${flag}`, async () => {
      const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
      if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
        throw new RolloutGuardError('INVALID_ROLLOUT', `reason must explain the rollout (${MIN_REASON}-${MAX_REASON} characters)`);
      }
      const thresholds = validateThresholds(request.thresholds);
      const scope = validateScope(request.scope);

      const active = [...this.rollouts.values()].filter((r) => isActive(r.state));
      if (active.some((r) => r.flag === flag)) {
        throw new RolloutGuardError('ROLLOUT_ALREADY_ACTIVE', `A rollout for "${flag}" is already active`);
      }
      if (active.length >= this.maxActive) {
        throw new RolloutGuardError('TOO_MANY_ACTIVE_ROLLOUTS', `At most ${this.maxActive} rollouts may be active at once`);
      }

      const before = this.flagState(flag);
      if (before.effective) {
        throw new RolloutGuardError('NOTHING_TO_ROLL_OUT', `"${flag}" is already enabled (${before.source}); there is nothing to roll out`);
      }

      let baseline: SignalSample;
      try {
        baseline = await this.options.signals(scope);
      } catch (err) {
        throw new RolloutGuardError('SIGNAL_UNAVAILABLE', `Health signal unavailable, so the flag was not changed: ${errorText(err)}`);
      }

      // Throws AdminConfigError (conflict, audit down, ...) before anything is recorded.
      const applied = this.options.config.setFeatureFlag({
        flag,
        enabled: true,
        reason: `Rollout started: ${reason}`,
        expectedVersion: this.options.config.snapshot().version,
        actorId: request.actorId,
        capabilityId: request.capabilityId,
        correlationId: request.correlationId,
      });

      const at = this.now().toISOString();
      const rollout: RolloutRecord = {
        id: this.newId(),
        flag,
        state: 'MONITORING',
        reason,
        startedBy: request.actorId,
        startedAt: at,
        finishedAt: null,
        thresholds,
        scope,
        previous: { override: before.override, effective: before.effective },
        appliedConfigVersion: applied.version,
        baseline,
        window: { total: 0, failures: 0, failureRate: 0 },
        signalFailures: 0,
        trigger: null,
        rollbackAttempts: 0,
        rollbackVerification: null,
        lastError: null,
        needsAttention: false,
        events: [],
      };
      this.event(rollout, 'STARTED', `Enabled ${flag}; watching ${scope.operations?.join(', ') ?? 'all operations'} for ${thresholds.observationMs}ms`);
      this.rollouts.set(rollout.id, rollout);
      this.prune();
      return this.view(rollout);
    });
  }

  /**
   * Take one reading and act on it. Safe to call on a timer and safe to repeat:
   * a finished rollout is returned unchanged, and a pending rollback is retried.
   */
  async evaluate(id: string): Promise<RolloutRecord> {
    this.get(id);
    return this.serialize(`rollout:${id}`, async () => {
      const rollout = this.get(id);
      if (rollout.state === 'ROLLBACK_PENDING') return this.view(await this.rollbackNow(rollout, rollout.trigger ?? 'MANUAL', rollout.lastError ?? 'retrying rollback', null));
      if (rollout.state !== 'MONITORING') return this.view(rollout);

      const current = this.flagState(rollout.flag);
      if (current.override !== true) {
        this.finish(rollout, 'SUPERSEDED');
        this.event(rollout, 'SUPERSEDED', `Override changed outside the rollout (now ${current.source}, ${current.effective}); the guard left it alone`);
        return this.view(rollout);
      }

      let sample: SignalSample;
      try {
        sample = await this.options.signals(rollout.scope);
      } catch (err) {
        rollout.signalFailures += 1;
        this.event(rollout, 'SIGNAL_ERROR', `Signal unreadable (${rollout.signalFailures}/${rollout.thresholds.maxSignalFailures}): ${errorText(err)}`);
        if (rollout.signalFailures >= rollout.thresholds.maxSignalFailures) {
          return this.view(await this.rollbackNow(rollout, 'SIGNAL_LOST', `Health signal lost for ${rollout.signalFailures} consecutive readings`, null));
        }
        return this.view(rollout);
      }
      rollout.signalFailures = 0;

      if (sample.total < rollout.baseline.total || sample.failures < rollout.baseline.failures) {
        // Counters went backwards (restart or reset): measure from here instead.
        rollout.baseline = sample;
        this.event(rollout, 'SAMPLED', 'Counters reset; baseline re-taken');
      }
      const total = sample.total - rollout.baseline.total;
      const failures = sample.failures - rollout.baseline.failures;
      rollout.window = { total, failures, failureRate: total > 0 ? Number((failures / total).toFixed(4)) : 0 };
      this.event(rollout, 'SAMPLED', `${failures}/${total} failed (${rollout.window.failureRate})`);

      const trusted = total >= rollout.thresholds.minSamples;
      if (trusted && rollout.window.failureRate > rollout.thresholds.maxFailureRate) {
        return this.view(
          await this.rollbackNow(
            rollout,
            'THRESHOLD_BREACH',
            `Failure rate ${rollout.window.failureRate} exceeded ${rollout.thresholds.maxFailureRate} over ${total} operations`,
            null
          )
        );
      }
      const elapsed = this.now().getTime() - Date.parse(rollout.startedAt);
      if (elapsed >= rollout.thresholds.observationMs) {
        if (trusted) {
          this.finish(rollout, 'PROMOTED');
          this.event(rollout, 'PROMOTED', `Healthy over ${total} operations; make it durable by setting ${FEATURE_FLAGS[rollout.flag].env}=true`);
        } else {
          return this.view(
            await this.rollbackNow(rollout, 'INSUFFICIENT_SIGNAL', `Only ${total} of ${rollout.thresholds.minSamples} required operations observed; health cannot be shown`, null)
          );
        }
      }
      return this.view(rollout);
    });
  }

  /** Operator rollback. Idempotent; also the way to retry a pending rollback. */
  async rollback(id: string, request: RollbackRequest): Promise<RolloutRecord> {
    this.get(id);
    return this.serialize(`rollout:${id}`, async () => {
      const rollout = this.get(id);
      const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
      if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
        throw new RolloutGuardError('INVALID_ROLLOUT', `reason must explain the rollback (${MIN_REASON}-${MAX_REASON} characters)`);
      }
      if (rollout.state === 'ROLLED_BACK') return this.view(rollout);
      if (rollout.state === 'PROMOTED' || rollout.state === 'SUPERSEDED') {
        throw new RolloutGuardError('ROLLOUT_FINISHED', `Rollout is ${rollout.state}; use a feature-flag change to reverse it`);
      }
      return this.view(await this.rollbackNow(rollout, 'MANUAL', reason, request));
    });
  }

  private finish(rollout: RolloutRecord, state: RolloutState) {
    rollout.state = state;
    rollout.finishedAt = this.now().toISOString();
    rollout.needsAttention = false;
  }

  /**
   * Restore the pre-rollout override, then verify it. Leaves the rollout in
   * ROLLBACK_PENDING (needsAttention) unless the restore verified.
   */
  private async rollbackNow(
    rollout: RolloutRecord,
    trigger: RolloutTrigger,
    reason: string,
    actor: RollbackRequest | null
  ): Promise<RolloutRecord> {
    const found = this.flagState(rollout.flag);
    if (found.override !== true && found.override !== rollout.previous.override) {
      // Someone else set a different override after the rollout began; that decision stands.
      this.finish(rollout, 'SUPERSEDED');
      this.event(rollout, 'SUPERSEDED', `Override is ${found.override}, set outside the rollout; the guard left it alone`);
      return rollout;
    }
    rollout.state = 'ROLLBACK_PENDING';
    rollout.trigger = trigger;
    rollout.needsAttention = true;
    const label = `Rollout ${rollout.id} rolled back (${trigger}): ${reason}`.slice(0, MAX_REASON);

    for (let attempt = 0; attempt < MAX_ROLLBACK_TRIES; attempt++) {
      rollout.rollbackAttempts += 1;
      this.event(rollout, 'ROLLBACK_ATTEMPT', `Attempt ${rollout.rollbackAttempts}: restore override to ${rollout.previous.override}`);
      try {
        this.options.config.setFeatureFlag({
          flag: rollout.flag,
          enabled: rollout.previous.override,
          reason: label,
          expectedVersion: this.options.config.snapshot().version,
          actorId: actor?.actorId ?? GUARD_ACTOR,
          capabilityId: actor?.capabilityId ?? `rollout:${rollout.id}`,
          correlationId: actor?.correlationId,
        });
        rollout.lastError = null;
        break;
      } catch (err) {
        rollout.lastError = errorText(err);
        const code = err instanceof AdminConfigError ? err.code : null;
        this.event(rollout, 'ROLLBACK_FAILED', `${code ?? 'ERROR'}: ${rollout.lastError}`);
        // A concurrent config change only moves the version: re-read and try again.
        if (code !== 'CONFIG_VERSION_CONFLICT') return rollout;
      }
    }

    const verification = this.verifyRollback(rollout);
    rollout.rollbackVerification = verification;
    if (!verification.verified) {
      rollout.lastError = verification.problems.join('; ');
      this.event(rollout, 'ROLLBACK_FAILED', `Verification failed: ${rollout.lastError}`);
      return rollout;
    }
    this.finish(rollout, 'ROLLED_BACK');
    this.event(rollout, 'ROLLED_BACK', `Verified: ${rollout.flag} is ${verification.effective} from ${verification.source}`);
    return rollout;
  }

  /** Read the flag back and compare it with the state captured before the rollout. */
  private verifyRollback(rollout: RolloutRecord): RollbackVerification {
    const state = this.flagState(rollout.flag);
    const problems: string[] = [];
    if (state.override !== rollout.previous.override) {
      problems.push(`override is ${state.override}, expected ${rollout.previous.override}`);
    }
    if (state.effective !== rollout.previous.effective) {
      problems.push(`effective value is ${state.effective}, expected ${rollout.previous.effective}`);
    }
    return {
      verified: problems.length === 0,
      checkedAt: this.now().toISOString(),
      effective: state.effective,
      source: state.source,
      expectedEffective: rollout.previous.effective,
      problems,
    };
  }
}
