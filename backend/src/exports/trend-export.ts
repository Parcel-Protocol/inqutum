/**
 * Historical Trend Export for Operational and Financial Metrics.
 *
 * Provides maintainers with versioned, privacy-safe historical trend exports
 * spanning financial/protocol settlement volume, invoice lifecycle outcomes,
 * operational latency, failure breakdowns, background job queues, and SLA breaches.
 *
 * Key Guarantees:
 *  - Explicit Schema & Generation Metadata: Every export carries `schema`,
 *    `schemaVersion`, `version`, `exportId`, `generatedAt`, `granularity`,
 *    `dateRange`, `recordCounts`, `truncated` flags, and `privacy` audit metadata.
 *  - Exact Stroop Financial Aggregation: Asset volumes are accumulated in
 *    64-bit integer stroops per canonical asset identity (`XLM` or `CODE:ISSUER`)
 *    so floating-point drift and cross-issuer collisions cannot occur.
 *  - Privacy & Sensitive Dimension Protection: Requires maintainer authorization
 *    and strictly blocks private/PII dimensions (`customerEmail`, `payerEmail`,
 *    `payerName`, `sellerEmail`, `sellerPublicKey`, `rawMemo`, `ip`, `secret`, etc.).
 *    Cohort grouping uses one-way SHA-256 anonymization.
 *  - Bounded Large Result Sets: Enforces `maxSourceRecords` and `maxBuckets`
 *    caps with explicit `truncated` metadata.
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { InvoiceStorage, InvoiceStatus, StoredInvoice } from '../storage/invoice-storage';
import { INVOICE_STATUSES } from '../storage/invoice-storage';
import type { Job, JobStore } from '../jobs/job-types';
import type { StructuredLogEntry } from '../observability/telemetry';
import { sanitizeLabelValue } from '../observability/telemetry';
import { redactSensitiveText } from '../security/redaction';
import { formatAssetIdentity, resolveInvoiceAsset } from '../utils/asset-helpers';
import { STROOP_DECIMALS } from '../utils/verify-amount-tolerance';
import { csvCell, type ExportFormat } from './export-service';

export const TREND_EXPORT_SCHEMA_ID = 'inqutum.historical-trend-export';
export const TREND_EXPORT_SCHEMA_VERSION = '1.0.0';
export const TREND_EXPORT_NUMERIC_VERSION = 1;

export const TREND_GRANULARITIES = ['hour', 'day', 'week', 'month'] as const;
export type TrendWindowGranularity = (typeof TREND_GRANULARITIES)[number];

export const ALLOWED_TREND_DIMENSIONS = [
  'asset',
  'status',
  'operation',
  'errorCode',
  'actorType',
  'jobType',
  'sellerCohort',
] as const;
export type AllowedTrendDimension = (typeof ALLOWED_TREND_DIMENSIONS)[number];

export const SENSITIVE_TREND_DIMENSIONS = [
  'customerName',
  'customerEmail',
  'payerName',
  'payerEmail',
  'sellerName',
  'sellerEmail',
  'sellerPublicKey',
  'payerPublicKey',
  'rawMemo',
  'memo',
  'description',
  'paymentTxHash',
  'ip',
  'userAgent',
  'secret',
  'privateKey',
  'token',
] as const;
export type SensitiveTrendDimension = (typeof SENSITIVE_TREND_DIMENSIONS)[number];

export const DEFAULT_MAX_TREND_BUCKETS = 500;
export const DEFAULT_MAX_SOURCE_RECORDS = 50_000;
export const DEFAULT_SLA_LATENCY_THRESHOLD_MS = 2_500;
export const DEFAULT_OVERDUE_SLA_GRACE_MS = 2 * 60_000;

export interface TrendExportActor {
  id: string;
  role: 'maintainer' | 'admin' | 'seller' | 'payer' | 'anonymous' | string;
  capabilities?: string[];
}

export interface TrendExportRequest {
  actor: TrendExportActor;
  granularity?: TrendWindowGranularity;
  format?: ExportFormat;
  from?: Date | string;
  to?: Date | string;
  dimensions?: string[];
  fillEmptyBuckets?: boolean;
  maxBuckets?: number;
  maxSourceRecords?: number;
  slaLatencyThresholdMs?: number;
}

export interface TrendSourceData {
  invoices?: readonly StoredInvoice[];
  operations?: readonly StructuredLogEntry[];
  jobs?: readonly Job[];
}

export interface FinancialTrendMetrics {
  invoicesCreated: number;
  invoicesPaid: number;
  invoicesExpired: number;
  invoicesCancelled: number;
  invoicesPending: number;
  settlementRate: number;
  grossVolumeByAsset: Record<string, string>;
  settledVolumeByAsset: Record<string, string>;
  avgSettlementLatencyMs: number;
}

export interface OperationalTrendMetrics {
  operationsTotal: number;
  operationsSucceeded: number;
  operationsFailed: number;
  failureRate: number;
  failuresByCode: Record<string, number>;
  avgLatencyMs: number;
  p95LatencyMs: number;
  jobsSucceeded: number;
  jobsDeadLettered: number;
  jobsQueued: number;
  jobRetriesTotal: number;
  slaBreaches: number;
}

export interface TrendBucket {
  windowStart: string;
  windowEnd: string;
  financial: FinancialTrendMetrics;
  operational: OperationalTrendMetrics;
  dimensions?: Partial<Record<AllowedTrendDimension, Record<string, number>>>;
}

export interface TrendExportMetadata {
  schema: typeof TREND_EXPORT_SCHEMA_ID;
  schemaVersion: typeof TREND_EXPORT_SCHEMA_VERSION;
  version: typeof TREND_EXPORT_NUMERIC_VERSION;
  exportId: string;
  generatedAt: string;
  generatedBy: { actorId: string; role: string };
  granularity: TrendWindowGranularity;
  format: ExportFormat;
  dateRange: {
    from: string | null;
    to: string | null;
  };
  sourceCounts: {
    invoicesEvaluated: number;
    operationsEvaluated: number;
    jobsEvaluated: number;
  };
  bucketCount: number;
  truncated: boolean;
  truncationReasons: Array<'MAX_SOURCE_RECORDS_REACHED' | 'MAX_BUCKETS_REACHED'>;
  privacy: {
    piiStripped: true;
    allowedDimensions: AllowedTrendDimension[];
    anonymizedDimensions: AllowedTrendDimension[];
    blockedSensitiveDimensions: readonly string[];
  };
}

export interface TrendExportArtifact {
  meta: TrendExportMetadata;
  totals: {
    financial: FinancialTrendMetrics;
    operational: OperationalTrendMetrics;
  };
  buckets: TrendBucket[];
  contentType: string;
  body: string;
}

export class TrendExportPermissionError extends Error {
  readonly code: 'TREND_EXPORT_FORBIDDEN' | 'SENSITIVE_DIMENSION_FORBIDDEN';
  readonly httpStatus = 403;
  readonly blockedDimensions?: string[];

  constructor(
    code: 'TREND_EXPORT_FORBIDDEN' | 'SENSITIVE_DIMENSION_FORBIDDEN',
    message: string,
    blockedDimensions?: string[]
  ) {
    super(message);
    this.name = 'TrendExportPermissionError';
    this.code = code;
    this.blockedDimensions = blockedDimensions;
  }
}

export class TrendExportValidationError extends Error {
  readonly code = 'INVALID_TREND_EXPORT_REQUEST';
  readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'TrendExportValidationError';
  }
}

const STELLAR_MAX_AMOUNT = 922_337_203_685.4775807;

function toStroops(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0 || amount > STELLAR_MAX_AMOUNT) {
    return 0n;
  }
  return BigInt(amount.toFixed(STROOP_DECIMALS).replace('.', ''));
}

function formatStroops(stroops: bigint): string {
  const digits = stroops.toString().padStart(STROOP_DECIMALS + 1, '0');
  return `${digits.slice(0, -STROOP_DECIMALS)}.${digits.slice(-STROOP_DECIMALS)}`;
}

/**
 * Anonymizes a Stellar public key into a deterministic non-reversible cohort tag
 * so seller concentration trends can be studied without leaking raw wallet addresses.
 */
export function anonymizeSellerCohort(sellerPublicKey: string): string {
  const digest = crypto.createHash('sha256').update(`inqutum-cohort:${sellerPublicKey}`).digest('hex');
  return `cohort_${digest.slice(0, 8)}`;
}

/**
 * Floors a timestamp to the start of its UTC aggregation window.
 */
export function floorToWindowStart(date: Date, granularity: TrendWindowGranularity): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const h = date.getUTCHours();

  switch (granularity) {
    case 'hour':
      return new Date(Date.UTC(y, m, d, h, 0, 0, 0));
    case 'day':
      return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
    case 'week': {
      // ISO week starts on Monday (1); Sunday (0) shifts back 6 days
      const dayOfWeek = date.getUTCDay();
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      return new Date(Date.UTC(y, m, d + diffToMonday, 0, 0, 0, 0));
    }
    case 'month':
      return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  }
}

/**
 * Advances a UTC window start timestamp by exactly 1 unit of `granularity`.
 */
export function advanceWindow(windowStart: Date, granularity: TrendWindowGranularity): Date {
  const y = windowStart.getUTCFullYear();
  const m = windowStart.getUTCMonth();
  const d = windowStart.getUTCDate();
  const h = windowStart.getUTCHours();

  switch (granularity) {
    case 'hour':
      return new Date(Date.UTC(y, m, d, h + 1, 0, 0, 0));
    case 'day':
      return new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0));
    case 'week':
      return new Date(Date.UTC(y, m, d + 7, 0, 0, 0, 0));
    case 'month':
      return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  }
}

interface MutableBucketAccumulator {
  windowStart: Date;
  windowEnd: Date;
  invoicesCreated: number;
  invoicesPaid: number;
  invoicesExpired: number;
  invoicesCancelled: number;
  invoicesPending: number;
  grossVolume: Map<string, bigint>;
  settledVolume: Map<string, bigint>;
  settlementLatenciesMs: number[];
  operationsTotal: number;
  operationsSucceeded: number;
  operationsFailed: number;
  failuresByCode: Map<string, number>;
  operationLatenciesMs: number[];
  jobsSucceeded: number;
  jobsDeadLettered: number;
  jobsQueued: number;
  jobRetriesTotal: number;
  slaBreaches: number;
  dimensions: Map<AllowedTrendDimension, Map<string, number>>;
}

function createAccumulator(
  windowStart: Date,
  granularity: TrendWindowGranularity,
  requestedDimensions: AllowedTrendDimension[]
): MutableBucketAccumulator {
  const dimensions = new Map<AllowedTrendDimension, Map<string, number>>();
  for (const dim of requestedDimensions) {
    dimensions.set(dim, new Map());
  }
  return {
    windowStart,
    windowEnd: advanceWindow(windowStart, granularity),
    invoicesCreated: 0,
    invoicesPaid: 0,
    invoicesExpired: 0,
    invoicesCancelled: 0,
    invoicesPending: 0,
    grossVolume: new Map(),
    settledVolume: new Map(),
    settlementLatenciesMs: [],
    operationsTotal: 0,
    operationsSucceeded: 0,
    operationsFailed: 0,
    failuresByCode: new Map(),
    operationLatenciesMs: [],
    jobsSucceeded: 0,
    jobsDeadLettered: 0,
    jobsQueued: 0,
    jobRetriesTotal: 0,
    slaBreaches: 0,
    dimensions,
  };
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return Number((sorted[Math.max(0, idx)] ?? 0).toFixed(2));
}

function computeAverage(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Number((sum / values.length).toFixed(2));
}

function finalizeBucket(acc: MutableBucketAccumulator): TrendBucket {
  const grossVolumeByAsset: Record<string, string> = {};
  for (const [asset, stroops] of [...acc.grossVolume.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    grossVolumeByAsset[asset] = formatStroops(stroops);
  }

  const settledVolumeByAsset: Record<string, string> = {};
  for (const [asset, stroops] of [...acc.settledVolume.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    settledVolumeByAsset[asset] = formatStroops(stroops);
  }

  const failuresByCode: Record<string, number> = {};
  for (const [code, count] of [...acc.failuresByCode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    failuresByCode[code] = count;
  }

  const bucket: TrendBucket = {
    windowStart: acc.windowStart.toISOString(),
    windowEnd: acc.windowEnd.toISOString(),
    financial: {
      invoicesCreated: acc.invoicesCreated,
      invoicesPaid: acc.invoicesPaid,
      invoicesExpired: acc.invoicesExpired,
      invoicesCancelled: acc.invoicesCancelled,
      invoicesPending: acc.invoicesPending,
      settlementRate:
        acc.invoicesCreated > 0 ? Number((acc.invoicesPaid / acc.invoicesCreated).toFixed(4)) : 0,
      grossVolumeByAsset,
      settledVolumeByAsset,
      avgSettlementLatencyMs: computeAverage(acc.settlementLatenciesMs),
    },
    operational: {
      operationsTotal: acc.operationsTotal,
      operationsSucceeded: acc.operationsSucceeded,
      operationsFailed: acc.operationsFailed,
      failureRate:
        acc.operationsTotal > 0 ? Number((acc.operationsFailed / acc.operationsTotal).toFixed(4)) : 0,
      failuresByCode,
      avgLatencyMs: computeAverage(acc.operationLatenciesMs),
      p95LatencyMs: computePercentile(acc.operationLatenciesMs, 95),
      jobsSucceeded: acc.jobsSucceeded,
      jobsDeadLettered: acc.jobsDeadLettered,
      jobsQueued: acc.jobsQueued,
      jobRetriesTotal: acc.jobRetriesTotal,
      slaBreaches: acc.slaBreaches,
    },
  };

  if (acc.dimensions.size > 0) {
    const dimOut: Partial<Record<AllowedTrendDimension, Record<string, number>>> = {};
    for (const [dim, counts] of acc.dimensions.entries()) {
      dimOut[dim] = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    }
    bucket.dimensions = dimOut;
  }

  return bucket;
}

function parseDateBound(raw: Date | string | undefined, fieldName: 'from' | 'to'): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = raw instanceof Date ? new Date(raw.getTime()) : new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    throw new TrendExportValidationError(`${fieldName} must be a valid ISO-8601 date`);
  }
  return d;
}

function validateAndAuthorizeRequest(request: TrendExportRequest): {
  granularity: TrendWindowGranularity;
  format: ExportFormat;
  from: Date | null;
  to: Date | null;
  allowedDimensions: AllowedTrendDimension[];
  maxBuckets: number;
  maxSourceRecords: number;
  slaLatencyThresholdMs: number;
} {
  if (!request || !request.actor || !request.actor.id || typeof request.actor.id !== 'string') {
    throw new TrendExportPermissionError(
      'TREND_EXPORT_FORBIDDEN',
      'Maintainer authentication is required to export operational and financial trends.'
    );
  }

  const role = String(request.actor.role || '').toLowerCase();
  if (role !== 'maintainer' && role !== 'admin') {
    throw new TrendExportPermissionError(
      'TREND_EXPORT_FORBIDDEN',
      `Role '${request.actor.role}' is not authorized to export platform-wide historical trends. Maintainer role required.`
    );
  }

  const granularity = request.granularity ?? 'day';
  if (!TREND_GRANULARITIES.includes(granularity)) {
    throw new TrendExportValidationError(
      `Invalid granularity '${String(granularity)}'. Must be one of: ${TREND_GRANULARITIES.join(', ')}`
    );
  }

  const format = request.format ?? 'json';
  if (format !== 'json' && format !== 'csv') {
    throw new TrendExportValidationError(`Invalid format '${String(format)}'. Must be 'json' or 'csv'`);
  }

  const from = parseDateBound(request.from, 'from');
  const to = parseDateBound(request.to, 'to');
  if (from && to && from.getTime() > to.getTime()) {
    throw new TrendExportValidationError('from date must not be after to date');
  }

  const requestedDims = request.dimensions ?? [];
  const blocked: string[] = [];
  const allowedDimensions: AllowedTrendDimension[] = [];

  for (const dim of requestedDims) {
    if ((SENSITIVE_TREND_DIMENSIONS as readonly string[]).includes(dim)) {
      blocked.push(dim);
    } else if ((ALLOWED_TREND_DIMENSIONS as readonly string[]).includes(dim)) {
      if (!allowedDimensions.includes(dim as AllowedTrendDimension)) {
        allowedDimensions.push(dim as AllowedTrendDimension);
      }
    } else {
      // Unknown or unapproved dimension is treated as potentially sensitive (deny-by-default)
      blocked.push(dim);
    }
  }

  if (blocked.length > 0) {
    throw new TrendExportPermissionError(
      'SENSITIVE_DIMENSION_FORBIDDEN',
      `Export denied: sensitive or unapproved dimension(s) requested: ${blocked.join(', ')}`,
      blocked
    );
  }

  const maxBuckets = request.maxBuckets ?? DEFAULT_MAX_TREND_BUCKETS;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
    throw new TrendExportValidationError('maxBuckets must be a positive integer');
  }

  const maxSourceRecords = request.maxSourceRecords ?? DEFAULT_MAX_SOURCE_RECORDS;
  if (!Number.isSafeInteger(maxSourceRecords) || maxSourceRecords <= 0) {
    throw new TrendExportValidationError('maxSourceRecords must be a positive integer');
  }

  const slaLatencyThresholdMs = request.slaLatencyThresholdMs ?? DEFAULT_SLA_LATENCY_THRESHOLD_MS;
  if (typeof slaLatencyThresholdMs !== 'number' || !Number.isFinite(slaLatencyThresholdMs) || slaLatencyThresholdMs <= 0) {
    throw new TrendExportValidationError('slaLatencyThresholdMs must be a positive number');
  }

  return {
    granularity,
    format,
    from,
    to,
    allowedDimensions,
    maxBuckets,
    maxSourceRecords,
    slaLatencyThresholdMs,
  };
}

function incrementDimension(
  acc: MutableBucketAccumulator,
  dim: AllowedTrendDimension,
  key: string,
  delta = 1
): void {
  const map = acc.dimensions.get(dim);
  if (!map) return;
  const safeKey = sanitizeLabelValue(redactSensitiveText(key));
  map.set(safeKey, (map.get(safeKey) ?? 0) + delta);
}

/**
 * Pure, deterministic aggregation of historical trend metrics from source data.
 */
export function generateHistoricalTrendExport(
  request: TrendExportRequest,
  source: TrendSourceData,
  now: Date = new Date()
): TrendExportArtifact {
  const config = validateAndAuthorizeRequest(request);
  const {
    granularity,
    format,
    from,
    to,
    allowedDimensions,
    maxBuckets,
    maxSourceRecords,
    slaLatencyThresholdMs,
  } = config;

  const truncationReasons: Array<'MAX_SOURCE_RECORDS_REACHED' | 'MAX_BUCKETS_REACHED'> = [];
  let sourceRecordsSeen = 0;

  const bucketMap = new Map<number, MutableBucketAccumulator>();
  const totalAcc = createAccumulator(
    from ? floorToWindowStart(from, granularity) : floorToWindowStart(now, granularity),
    granularity,
    allowedDimensions
  );

  const getOrCreateBucket = (timestamp: Date): MutableBucketAccumulator => {
    const start = floorToWindowStart(timestamp, granularity);
    const key = start.getTime();
    let b = bucketMap.get(key);
    if (!b) {
      b = createAccumulator(start, granularity, allowedDimensions);
      bucketMap.set(key, b);
    }
    return b;
  };

  const inRange = (tsMs: number): boolean => {
    if (from && tsMs < from.getTime()) return false;
    if (to && tsMs > to.getTime()) return false;
    return true;
  };

  let invoicesEvaluated = 0;
  let operationsEvaluated = 0;
  let jobsEvaluated = 0;

  // 1. Aggregate Invoices (Financial & Lifecycle + Overdue SLA breaches)
  const invoices = source.invoices ?? [];
  for (const inv of invoices) {
    const createdMs = new Date(inv.createdAt).getTime();
    if (Number.isNaN(createdMs) || !inRange(createdMs)) continue;

    if (sourceRecordsSeen >= maxSourceRecords) {
      if (!truncationReasons.includes('MAX_SOURCE_RECORDS_REACHED')) {
        truncationReasons.push('MAX_SOURCE_RECORDS_REACHED');
      }
      break;
    }
    sourceRecordsSeen += 1;
    invoicesEvaluated += 1;

    const bucket = getOrCreateBucket(new Date(createdMs));
    const assetIdentity = formatAssetIdentity(resolveInvoiceAsset(inv));
    const stroops = toStroops(inv.amount);

    for (const target of [bucket, totalAcc]) {
      target.invoicesCreated += 1;
      if (inv.status === 'PAID') target.invoicesPaid += 1;
      else if (inv.status === 'EXPIRED') target.invoicesExpired += 1;
      else if (inv.status === 'CANCELLED') target.invoicesCancelled += 1;
      else if (inv.status === 'PENDING') target.invoicesPending += 1;

      if (stroops > 0n) {
        target.grossVolume.set(assetIdentity, (target.grossVolume.get(assetIdentity) ?? 0n) + stroops);
        if (inv.status === 'PAID') {
          target.settledVolume.set(assetIdentity, (target.settledVolume.get(assetIdentity) ?? 0n) + stroops);
        }
      }

      if (inv.status === 'PAID' && inv.paidAt) {
        const paidMs = new Date(inv.paidAt).getTime();
        if (!Number.isNaN(paidMs) && paidMs >= createdMs) {
          target.settlementLatenciesMs.push(paidMs - createdMs);
        }
      }

      // Overdue pending invoice past grace period counts as an SLA breach
      const expiresMs = new Date(inv.expiresAt).getTime();
      if (inv.status === 'PENDING' && !Number.isNaN(expiresMs) && expiresMs + DEFAULT_OVERDUE_SLA_GRACE_MS < now.getTime()) {
        target.slaBreaches += 1;
      }

      incrementDimension(target, 'asset', assetIdentity);
      incrementDimension(target, 'status', inv.status);
      incrementDimension(target, 'sellerCohort', anonymizeSellerCohort(inv.sellerPublicKey));
    }
  }

  // 2. Aggregate Operations / Telemetry logs
  const operations = source.operations ?? [];
  for (const op of operations) {
    const opMs = Date.parse(op.timestamp);
    if (Number.isNaN(opMs) || !inRange(opMs)) continue;

    if (sourceRecordsSeen >= maxSourceRecords) {
      if (!truncationReasons.includes('MAX_SOURCE_RECORDS_REACHED')) {
        truncationReasons.push('MAX_SOURCE_RECORDS_REACHED');
      }
      break;
    }
    sourceRecordsSeen += 1;
    operationsEvaluated += 1;

    const bucket = getOrCreateBucket(new Date(opMs));
    const isFailure = op.result === 'failure';
    const latency = Number.isFinite(op.latency_ms) && op.latency_ms >= 0 ? op.latency_ms : 0;
    const safeErrorCode = op.error_code
      ? sanitizeLabelValue(redactSensitiveText(String(op.error_code)))
      : isFailure
      ? 'UNSPECIFIED_ERROR'
      : null;

    for (const target of [bucket, totalAcc]) {
      target.operationsTotal += 1;
      if (isFailure) {
        target.operationsFailed += 1;
        if (safeErrorCode) {
          target.failuresByCode.set(safeErrorCode, (target.failuresByCode.get(safeErrorCode) ?? 0) + 1);
        }
      } else {
        target.operationsSucceeded += 1;
      }

      target.operationLatenciesMs.push(latency);
      if (latency > slaLatencyThresholdMs) {
        target.slaBreaches += 1;
      }

      incrementDimension(target, 'operation', op.operation);
      incrementDimension(target, 'actorType', op.actor_type);
      if (safeErrorCode) {
        incrementDimension(target, 'errorCode', safeErrorCode);
      }
    }
  }

  // 3. Aggregate Background Jobs
  const jobs = source.jobs ?? [];
  for (const job of jobs) {
    const jobMs = Date.parse(job.createdAt);
    if (Number.isNaN(jobMs) || !inRange(jobMs)) continue;

    if (sourceRecordsSeen >= maxSourceRecords) {
      if (!truncationReasons.includes('MAX_SOURCE_RECORDS_REACHED')) {
        truncationReasons.push('MAX_SOURCE_RECORDS_REACHED');
      }
      break;
    }
    sourceRecordsSeen += 1;
    jobsEvaluated += 1;

    const bucket = getOrCreateBucket(new Date(jobMs));
    const retries = Math.max(0, (job.attempts ?? 0) - 1);

    for (const target of [bucket, totalAcc]) {
      if (job.status === 'succeeded') target.jobsSucceeded += 1;
      else if (job.status === 'dead') {
        target.jobsDeadLettered += 1;
        target.slaBreaches += 1;
      } else if (job.status === 'queued' || job.status === 'running') {
        target.jobsQueued += 1;
      }
      target.jobRetriesTotal += retries;
      incrementDimension(target, 'jobType', job.type);
    }
  }

  // 4. Fill empty buckets if requested and both `from` and `to` are specified
  if (request.fillEmptyBuckets && from && to) {
    let cursor = floorToWindowStart(from, granularity);
    const endBound = to.getTime();
    let safetyCounter = 0;
    while (cursor.getTime() <= endBound && safetyCounter <= maxBuckets) {
      const key = cursor.getTime();
      if (!bucketMap.has(key)) {
        bucketMap.set(key, createAccumulator(cursor, granularity, allowedDimensions));
      }
      cursor = advanceWindow(cursor, granularity);
      safetyCounter += 1;
    }
  }

  // Sort buckets chronologically and enforce maxBuckets cap
  const sortedAccumulators = [...bucketMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => acc);

  if (sortedAccumulators.length > maxBuckets) {
    truncationReasons.push('MAX_BUCKETS_REACHED');
  }

  const cappedAccumulators = sortedAccumulators.slice(0, maxBuckets);
  const buckets = cappedAccumulators.map(finalizeBucket);
  const finalizedTotals = finalizeBucket(totalAcc);

  const anonymizedDimensions = allowedDimensions.filter((d) => d === 'sellerCohort');

  const meta: TrendExportMetadata = {
    schema: TREND_EXPORT_SCHEMA_ID,
    schemaVersion: TREND_EXPORT_SCHEMA_VERSION,
    version: TREND_EXPORT_NUMERIC_VERSION,
    exportId: uuidv4(),
    generatedAt: now.toISOString(),
    generatedBy: {
      actorId: redactSensitiveText(request.actor.id),
      role: String(request.actor.role).toLowerCase(),
    },
    granularity,
    format,
    dateRange: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    },
    sourceCounts: {
      invoicesEvaluated,
      operationsEvaluated,
      jobsEvaluated,
    },
    bucketCount: buckets.length,
    truncated: truncationReasons.length > 0,
    truncationReasons,
    privacy: {
      piiStripped: true,
      allowedDimensions,
      anonymizedDimensions,
      blockedSensitiveDimensions: SENSITIVE_TREND_DIMENSIONS,
    },
  };

  const totals = {
    financial: finalizedTotals.financial,
    operational: finalizedTotals.operational,
  };

  const body =
    format === 'csv'
      ? renderTrendCsv(meta, buckets)
      : JSON.stringify({ meta, totals, buckets }, null, 2);

  return {
    meta,
    totals,
    buckets,
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    body,
  };
}

export const TREND_CSV_COLUMNS = [
  'schema',
  'schemaVersion',
  'granularity',
  'windowStart',
  'windowEnd',
  'invoicesCreated',
  'invoicesPaid',
  'invoicesExpired',
  'invoicesCancelled',
  'invoicesPending',
  'settlementRate',
  'grossVolumeByAsset',
  'settledVolumeByAsset',
  'avgSettlementLatencyMs',
  'operationsTotal',
  'operationsSucceeded',
  'operationsFailed',
  'failureRate',
  'avgLatencyMs',
  'p95LatencyMs',
  'jobsSucceeded',
  'jobsDeadLettered',
  'jobsQueued',
  'jobRetriesTotal',
  'slaBreaches',
] as const;

export function renderTrendCsv(meta: TrendExportMetadata, buckets: readonly TrendBucket[]): string {
  const header = TREND_CSV_COLUMNS.join(',');
  const rows = buckets.map((b) =>
    [
      csvCell(meta.schema),
      csvCell(meta.schemaVersion),
      csvCell(meta.granularity),
      csvCell(b.windowStart),
      csvCell(b.windowEnd),
      csvCell(b.financial.invoicesCreated),
      csvCell(b.financial.invoicesPaid),
      csvCell(b.financial.invoicesExpired),
      csvCell(b.financial.invoicesCancelled),
      csvCell(b.financial.invoicesPending),
      csvCell(b.financial.settlementRate),
      csvCell(JSON.stringify(b.financial.grossVolumeByAsset)),
      csvCell(JSON.stringify(b.financial.settledVolumeByAsset)),
      csvCell(b.financial.avgSettlementLatencyMs),
      csvCell(b.operational.operationsTotal),
      csvCell(b.operational.operationsSucceeded),
      csvCell(b.operational.operationsFailed),
      csvCell(b.operational.failureRate),
      csvCell(b.operational.avgLatencyMs),
      csvCell(b.operational.p95LatencyMs),
      csvCell(b.operational.jobsSucceeded),
      csvCell(b.operational.jobsDeadLettered),
      csvCell(b.operational.jobsQueued),
      csvCell(b.operational.jobRetriesTotal),
      csvCell(b.operational.slaBreaches),
    ].join(',')
  );
  return [header, ...rows].join('\r\n') + '\r\n';
}

export interface TrendExportServiceDeps {
  storage: InvoiceStorage;
  jobs?: JobStore;
  recentLogs?: () => StructuredLogEntry[];
  now?: () => Date;
}

/**
 * Service wrapper that loads live storage, job store, and telemetry logs
 * and produces a versioned historical trend export.
 */
export class TrendExportService {
  constructor(private readonly deps: TrendExportServiceDeps) {}

  async exportTrends(request: TrendExportRequest): Promise<TrendExportArtifact> {
    // Validate & authorize before reading storage
    validateAndAuthorizeRequest(request);

    const invoices = this.deps.storage.getAllInvoices
      ? await this.deps.storage.getAllInvoices()
      : [];
    const jobsResult = this.deps.jobs
      ? await this.deps.jobs.list({ limit: request.maxSourceRecords ?? DEFAULT_MAX_SOURCE_RECORDS })
      : { jobs: [], total: 0 };
    const operations = this.deps.recentLogs ? this.deps.recentLogs() : [];

    return generateHistoricalTrendExport(
      request,
      {
        invoices,
        jobs: jobsResult.jobs,
        operations,
      },
      this.deps.now ? this.deps.now() : new Date()
    );
  }
}
