/**
 * A small, dependency-free quota ledger for work that has a real operational
 * cost.  It deliberately records reservations (rather than successful work)
 * because the remote call/queue write is the cost we need to protect.
 *
 * The in-memory implementation is appropriate for the MVP.  The interface is
 * intentionally storage-shaped so a Redis/Postgres implementation can be
 * substituted without changing callers.
 */
export const QUOTA_OPERATIONS = [
  'invoice_create',
  'horizon_verify',
  'email_enqueue',
  'import_row',
  'search_index',
] as const;
export type QuotaOperation = (typeof QUOTA_OPERATIONS)[number];

export interface QuotaLimit {
  limit: number;
  windowMs: number;
}

export type QuotaLimits = Record<QuotaOperation, QuotaLimit>;

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  invoice_create: { limit: 100, windowMs: 60 * 60 * 1000 },
  horizon_verify: { limit: 60, windowMs: 60 * 60 * 1000 },
  email_enqueue: { limit: 20, windowMs: 60 * 60 * 1000 },
  import_row: { limit: 1_000, windowMs: 24 * 60 * 60 * 1000 },
  search_index: { limit: 10_000, windowMs: 24 * 60 * 60 * 1000 },
};

export interface QuotaSubject {
  /** A stable actor identity, normally a wallet or service identity. */
  actor: string;
  /** Optional resource key: an invoice, import, or index namespace. */
  resource?: string;
}

export interface QuotaUsage {
  operation: QuotaOperation;
  actor: string;
  resource?: string;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  overridden: boolean;
}

export type QuotaDecision =
  | { allowed: true; usage: QuotaUsage }
  | { allowed: false; code: 'QUOTA_EXCEEDED'; message: string; usage: QuotaUsage; retryAfterSeconds: number };

export interface QuotaOverride {
  operation: QuotaOperation;
  actor: string;
  resource?: string;
  /** Extra units allowed in the normal window.  Zero removes an override. */
  extraUnits: number;
  reason: string;
  setBy: string;
  setAt: string;
}

interface Bucket {
  startedAtMs: number;
  used: number;
}

function key(operation: QuotaOperation, subject: QuotaSubject): string {
  return `${operation}\u0000${subject.actor}\u0000${subject.resource ?? ''}`;
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** In-process quota store with deterministic clocks for tests. */
export class QuotaManager {
  private readonly buckets = new Map<string, Bucket>();
  private readonly overrides = new Map<string, QuotaOverride>();
  private readonly limits: QuotaLimits;

  constructor(limits: Partial<QuotaLimits> = {}) {
    this.limits = { ...DEFAULT_QUOTA_LIMITS, ...limits };
  }

  reserve(operation: QuotaOperation, subject: QuotaSubject, units = 1, nowMs = Date.now()): QuotaDecision {
    if (!validPositiveInteger(units)) throw new Error('Quota units must be a positive integer');
    if (!subject.actor || subject.actor.trim() === '') throw new Error('Quota actor is required');
    const configured = this.limits[operation];
    const bucketKey = key(operation, subject);
    const current = this.buckets.get(bucketKey);
    const startedAtMs = !current || nowMs >= current.startedAtMs + configured.windowMs ? nowMs : current.startedAtMs;
    const used = startedAtMs === current?.startedAtMs ? current.used : 0;
    const override = this.overrides.get(bucketKey);
    const limit = configured.limit + (override?.extraUnits ?? 0);
    const resetsAtMs = startedAtMs + configured.windowMs;
    const usage = (reserved: number): QuotaUsage => ({
      operation,
      actor: subject.actor,
      ...(subject.resource ? { resource: subject.resource } : {}),
      used: reserved,
      limit,
      remaining: Math.max(0, limit - reserved),
      resetsAt: new Date(resetsAtMs).toISOString(),
      overridden: Boolean(override),
    });

    if (used + units > limit) {
      return {
        allowed: false,
        code: 'QUOTA_EXCEEDED',
        message: `Quota exceeded for ${operation}. Try again after the quota window resets.`,
        usage: usage(used),
        retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - nowMs) / 1000)),
      };
    }
    this.buckets.set(bucketKey, { startedAtMs, used: used + units });
    return { allowed: true, usage: usage(used + units) };
  }

  inspect(subject: Partial<QuotaSubject> = {}, nowMs = Date.now()): QuotaUsage[] {
    const result: QuotaUsage[] = [];
    for (const operation of QUOTA_OPERATIONS) {
      for (const [bucketKey, bucket] of this.buckets) {
        const [entryOperation, actor, resource] = bucketKey.split('\u0000');
        if (entryOperation !== operation || (subject.actor && subject.actor !== actor) || (subject.resource && subject.resource !== resource)) continue;
        const config = this.limits[operation];
        if (nowMs >= bucket.startedAtMs + config.windowMs) continue;
        const override = this.overrides.get(bucketKey);
        const limit = config.limit + (override?.extraUnits ?? 0);
        result.push({ operation, actor, ...(resource ? { resource } : {}), used: bucket.used, limit, remaining: Math.max(0, limit - bucket.used), resetsAt: new Date(bucket.startedAtMs + config.windowMs).toISOString(), overridden: Boolean(override) });
      }
    }
    return result.sort((a, b) => `${a.operation}:${a.actor}:${a.resource ?? ''}`.localeCompare(`${b.operation}:${b.actor}:${b.resource ?? ''}`));
  }

  setOverride(input: Omit<QuotaOverride, 'setAt'>, nowMs = Date.now()): QuotaOverride | undefined {
    if (!Number.isSafeInteger(input.extraUnits) || input.extraUnits < 0) throw new Error('Override extraUnits must be a non-negative integer');
    if (!input.reason.trim() || !input.setBy.trim()) throw new Error('Quota overrides require a reason and maintainer identity');
    const bucketKey = key(input.operation, input);
    if (input.extraUnits === 0) {
      this.overrides.delete(bucketKey);
      return undefined;
    }
    const override: QuotaOverride = { ...input, setAt: new Date(nowMs).toISOString() };
    this.overrides.set(bucketKey, override);
    return { ...override };
  }

  reset(subject: QuotaSubject, operation?: QuotaOperation): number {
    let removed = 0;
    for (const bucketKey of this.buckets.keys()) {
      const [entryOperation, actor, resource] = bucketKey.split('\u0000');
      if (actor === subject.actor && resource === (subject.resource ?? '') && (!operation || entryOperation === operation)) {
        this.buckets.delete(bucketKey);
        removed += 1;
      }
    }
    return removed;
  }
}

export const quotaManager = new QuotaManager();
