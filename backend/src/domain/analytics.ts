/**
 * Privacy-preserving analytics aggregation for maintainer insights.
 *
 * Design principles:
 * - Aggregate by safe dimensions only (operation, status, time window, asset type)
 * - Never store raw sensitive values (wallet addresses, emails, tx hashes, amounts)
 * - Use counts, rates, and percentiles instead of raw values
 * - Retention windows bound memory and disk usage
 *
 * Safe dimensions:
 * - operation: the quota operation or API endpoint category
 * - status: success | failure | quota_exceeded | rate_limited
 * - timeWindow: hourly bucket key (YYYY-MM-DDTHH:00:00.000Z)
 * - assetType: native | credit (never the specific asset code or issuer)
 * - errorCode: stable machine-readable error code (safe to aggregate)
 *
 * Metrics exposed:
 * - request counts by operation and status
 * - success rate percentages
 * - quota exhaustion counts
 * - latency percentiles (p50, p95, p99) in milliseconds
 * - unique actor count (cardinality, not identities)
 */

export type AnalyticsOperation =
  | 'invoice_create'
  | 'horizon_verify'
  | 'email_enqueue'
  | 'import_row'
  | 'search_index'
  | 'payment_verify'
  | 'dashboard_list'
  | 'auth_challenge';

export type AnalyticsStatus = 'success' | 'failure' | 'quota_exceeded' | 'rate_limited';

export type AssetType = 'native' | 'credit';

export interface AnalyticsEvent {
  operation: AnalyticsOperation;
  status: AnalyticsStatus;
  /** Hourly bucket key: YYYY-MM-DDTHH:00:00.000Z */
  timeWindow: string;
  assetType?: AssetType;
  errorCode?: string;
  /** Request latency in milliseconds */
  latencyMs: number;
  /**
   * Actor cardinality key: a one-way hash of the actor identity.
   * We never store the raw actor identity, only this hash for counting
   * unique actors within a time window.
   */
  actorHash: string;
}

export interface AnalyticsAggregate {
  operation: AnalyticsOperation;
  timeWindow: string;
  assetType?: AssetType;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  quotaExceededCount: number;
  rateLimitedCount: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  uniqueActors: number;
  topErrorCodes: Array<{ code: string; count: number }>;
}

export interface AnalyticsSummary {
  generatedAt: string;
  retentionHours: number;
  totalEvents: number;
  aggregates: AnalyticsAggregate[];
}

/** Retention window in hours (default 7 days). */
export const DEFAULT_ANALYTICS_RETENTION_HOURS = 24 * 7;

/** Maximum number of hourly buckets to retain. */
const MAX_BUCKETS = 24 * 30; // 30 days

interface Bucket {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  quotaExceededCount: number;
  rateLimitedCount: number;
  latencies: number[];
  actorHashes: Set<string>;
  errorCounts: Map<string, number>;
}

function emptyBucket(): Bucket {
  return {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    quotaExceededCount: 0,
    rateLimitedCount: 0,
    latencies: [],
    actorHashes: new Set(),
    errorCounts: new Map(),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * In-memory privacy-preserving analytics store.
 *
 * This implementation is appropriate for the MVP and single-instance deployments.
 * The interface is intentionally storage-shaped so a Redis/Postgres implementation
 * can be substituted without changing callers.
 *
 * Privacy guarantees:
 * - No raw actor identities are stored (only one-way hashes for cardinality)
 * - No raw sensitive payloads are stored (only safe dimension values)
 * - Latency values are stored only for percentile computation, never exported raw
 * - Error codes are stable machine-readable strings, never user input
 */
export class AnalyticsStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly retentionHours: number;

  constructor(retentionHours: number = DEFAULT_ANALYTICS_RETENTION_HOURS) {
    this.retentionHours = retentionHours;
  }

  /**
   * Record an analytics event. Events are aggregated into hourly buckets
   * by operation and time window. No raw sensitive data is stored.
   */
  record(event: AnalyticsEvent, nowMs: number = Date.now()): void {
    const bucketKey = `${event.operation}${event.timeWindow}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = emptyBucket();
      this.buckets.set(bucketKey, bucket);
    }

    bucket.totalRequests += 1;
    bucket.latencies.push(event.latencyMs);
    bucket.actorHashes.add(event.actorHash);

    switch (event.status) {
      case 'success':
        bucket.successCount += 1;
        break;
      case 'failure':
        bucket.failureCount += 1;
        break;
      case 'quota_exceeded':
        bucket.quotaExceededCount += 1;
        break;
      case 'rate_limited':
        bucket.rateLimitedCount += 1;
        break;
    }

    if (event.errorCode) {
      bucket.errorCounts.set(event.errorCode, (bucket.errorCounts.get(event.errorCode) ?? 0) + 1);
    }

    this.evictOldBuckets(nowMs);
  }

  /**
   * Get aggregated analytics for a given time range.
   * Returns privacy-safe aggregates only — no raw events or identities.
   */
  query(options: {
    operation?: AnalyticsOperation;
    fromMs?: number;
    toMs?: number;
    nowMs?: number;
  } = {}): AnalyticsSummary {
    const nowMs = options.nowMs ?? Date.now();
    const fromMs = options.fromMs ?? nowMs - this.retentionHours * 60 * 60 * 1000;
    const toMs = options.toMs ?? nowMs;

    const aggregates: AnalyticsAggregate[] = [];
    let totalEvents = 0;

    for (const [bucketKey, bucket] of this.buckets) {
      const operation = bucketKey.slice(0, -'YYYY-MM-DDTHH:00:00.000Z'.length) as AnalyticsOperation;
      const timeWindow = bucketKey.slice(-'YYYY-MM-DDTHH:00:00.000Z'.length);

      if (options.operation && operation !== options.operation) continue;

      const bucketTimeMs = new Date(timeWindow).getTime();
      if (bucketTimeMs < fromMs || bucketTimeMs > toMs) continue;

      const sortedLatencies = [...bucket.latencies].sort((a, b) => a - b);
      const topErrorCodes = [...bucket.errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, count]) => ({ code, count }));

      aggregates.push({
        operation,
        timeWindow,
        totalRequests: bucket.totalRequests,
        successCount: bucket.successCount,
        failureCount: bucket.failureCount,
        quotaExceededCount: bucket.quotaExceededCount,
        rateLimitedCount: bucket.rateLimitedCount,
        successRate: bucket.totalRequests > 0 ? bucket.successCount / bucket.totalRequests : 0,
        p50LatencyMs: percentile(sortedLatencies, 50),
        p95LatencyMs: percentile(sortedLatencies, 95),
        p99LatencyMs: percentile(sortedLatencies, 99),
        uniqueActors: bucket.actorHashes.size,
        topErrorCodes,
      });

      totalEvents += bucket.totalRequests;
    }

    aggregates.sort((a, b) => {
      if (a.timeWindow !== b.timeWindow) return a.timeWindow.localeCompare(b.timeWindow);
      return a.operation.localeCompare(b.operation);
    });

    return {
      generatedAt: new Date(nowMs).toISOString(),
      retentionHours: this.retentionHours,
      totalEvents,
      aggregates,
    };
  }

  /**
   * Evict buckets older than the retention window.
   */
  private evictOldBuckets(nowMs: number): void {
    const cutoffMs = nowMs - this.retentionHours * 60 * 60 * 1000;
    for (const bucketKey of this.buckets.keys()) {
      const timeWindow = bucketKey.slice(-'YYYY-MM-DDTHH:00:00.000Z'.length);
      const bucketTimeMs = new Date(timeWindow).getTime();
      if (bucketTimeMs < cutoffMs) {
        this.buckets.delete(bucketKey);
      }
    }

    // Hard cap on bucket count to bound memory
    if (this.buckets.size > MAX_BUCKETS) {
      const sortedKeys = [...this.buckets.keys()].sort();
      const toRemove = sortedKeys.slice(0, sortedKeys.length - MAX_BUCKETS);
      for (const key of toRemove) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Clear all analytics data. Useful for testing and privacy compliance.
   */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * Get the current number of buckets (for testing/monitoring).
   */
  get bucketCount(): number {
    return this.buckets.size;
  }
}

/**
 * Create an hourly time window key from a timestamp.
 * Returns YYYY-MM-DDTHH:00:00.000Z format.
 */
export function hourlyTimeWindow(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

/**
 * One-way hash of an actor identity for cardinality counting.
 * Uses SHA-256 and returns a hex string. This is not reversible,
 * so the original identity cannot be recovered from the hash.
 */
export function hashActor(identity: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** Global analytics store instance. */
export const analyticsStore = new AnalyticsStore();
