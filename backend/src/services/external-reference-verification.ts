/**
 * Resilient External Reference Verification Service with Retry Policy.
 *
 * Verifies external protocol, ledger, anchor, webhook, and custody references
 * reliably without blocking forever on unresponsive endpoints or accepting
 * stale/malformed payloads.
 *
 * Key Guarantees:
 *  - Per-Attempt Deadline (`timeoutMs`): Every external probe is raced against
 *    a strict timer with `AbortSignal` cancellation so hung connections never
 *    block workers indefinitely.
 *  - Exponential Backoff Retry Policy: Transient failures (`SOURCE_TIMEOUT`,
 *    `SOURCE_UNREACHABLE`, `REFERENCE_PENDING_UPSTREAM`) are retried up to
 *    `maxAttempts`, while deterministic errors (`MALFORMED_SOURCE_RESPONSE`,
 *    `STALE_SOURCE_DATA`, `REFERENCE_REJECTED_BY_SOURCE`,
 *    `REFERENCE_MALFORMED_INPUT`) fail fast into `FAILED_TERMINAL`.
 *  - Persistent Verification Record: Stores verification outcome, timestamps,
 *    source metadata (`sourceSystem`, `observedTimestamp`, `ledgerSequence`,
 *    `responseLatencyMs`, `schemaVersion`), and per-attempt history.
 */

import { DEFAULT_RETRY_POLICY, computeBackoffMs, type RetryPolicy } from '../jobs/job-types';

export const EXTERNAL_REFERENCE_TYPES = [
  'stellar_transaction',
  'anchor_sep24_transfer',
  'webhook_callback_delivery',
  'custody_settlement_attestation',
] as const;
export type ExternalReferenceType = (typeof EXTERNAL_REFERENCE_TYPES)[number];

export type ExternalVerificationStatus =
  | 'PENDING'
  | 'RETRY_SCHEDULED'
  | 'VERIFIED'
  | 'FAILED_TERMINAL';

export type ExternalVerificationFailureCode =
  | 'REFERENCE_MALFORMED_INPUT'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_UNREACHABLE'
  | 'REFERENCE_PENDING_UPSTREAM'
  | 'MALFORMED_SOURCE_RESPONSE'
  | 'STALE_SOURCE_DATA'
  | 'REFERENCE_REJECTED_BY_SOURCE'
  | 'RETRY_EXHAUSTED';

export interface ExternalReferenceInput {
  referenceId: string;
  referenceType: ExternalReferenceType;
  invoiceId: string;
  externalIdentifier: string;
  sourceSystem: string;
  endpoint?: string;
  expectedAmount?: number;
  expectedAssetCode?: string;
}

export interface ExternalSourceRawResponse {
  status: 'verified' | 'pending' | 'rejected';
  observedTimestamp: string;
  sourceSystem?: string;
  ledgerSequence?: number;
  settledAmount?: number | string;
  assetCode?: string;
  rawStatus?: string;
  schemaVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface PersistedSourceMetadata {
  sourceSystem: string;
  endpoint: string | null;
  observedTimestamp: string;
  verifiedAt: string;
  ledgerSequence: number | null;
  settledAmount: string | null;
  assetCode: string | null;
  rawStatus: string;
  responseLatencyMs: number;
  schemaVersion: string;
}

export interface ExternalVerificationFailure {
  code: ExternalVerificationFailureCode;
  rootCauseCode?: ExternalVerificationFailureCode;
  message: string;
  retryable: boolean;
  recoveryHint: string;
  attempt: number;
  failedAt: string;
}

export interface VerificationAttemptEntry {
  attempt: number;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  outcome: 'verified' | 'retry_scheduled' | 'terminal_failure';
  errorCode?: ExternalVerificationFailureCode;
  message?: string;
}

export interface ExternalReferenceRecord {
  referenceId: string;
  referenceType: ExternalReferenceType;
  invoiceId: string;
  externalIdentifier: string;
  sourceSystem: string;
  endpoint: string | null;
  expectedAmount: number | null;
  expectedAssetCode: string | null;
  status: ExternalVerificationStatus;
  attempts: number;
  maxAttempts: number;
  verifiedAt: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  sourceMetadata: PersistedSourceMetadata | null;
  failure: ExternalVerificationFailure | null;
  attemptHistory: VerificationAttemptEntry[];
  createdAt: string;
  updatedAt: string;
}

export type ExternalReferenceProbe = (
  input: ExternalReferenceInput,
  signal: AbortSignal,
  attempt: number
) => Promise<unknown>;

export interface ExternalReferenceVerifierOptions {
  retryPolicy?: Partial<RetryPolicy>;
  /** Per-attempt timeout in milliseconds. Default: 3000ms. */
  timeoutMs?: number;
  /** Maximum age of source data timestamp before it is rejected as stale. Default: 24 hours. */
  maxStalenessMs?: number;
  /** Allowed future clock skew for source timestamps. Default: 60 seconds. */
  allowedClockSkewMs?: number;
  /** Clock provider for deterministic testing. */
  now?: () => Date;
  /** Sleep function for backoff waits; overridable in tests to avoid wall-clock delays. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 60_000;

const STELLAR_TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;
const SAFE_EXTERNAL_ID_REGEX = /^[A-Za-z0-9._:-]{3,256}$/;

const RECOVERY_HINTS: Record<ExternalVerificationFailureCode, string> = {
  REFERENCE_MALFORMED_INPUT:
    'Check the external reference identifier format (e.g., 64-character hex hash for Stellar transactions) and resubmit.',
  SOURCE_TIMEOUT:
    'The upstream verification source timed out. Automatic retry is scheduled; inspect upstream latency if timeouts persist.',
  SOURCE_UNREACHABLE:
    'The upstream verification endpoint could not be reached. Verify network connectivity or check /api/ops/dependencies.',
  REFERENCE_PENDING_UPSTREAM:
    'The external reference is still pending upstream finality. Wait for the next scheduled retry.',
  MALFORMED_SOURCE_RESPONSE:
    'The upstream source returned a payload that violates the expected verification schema. Inspect upstream API compatibility.',
  STALE_SOURCE_DATA:
    'The upstream source returned stale or post-dated data outside the freshness window. Request a fresh attestation.',
  REFERENCE_REJECTED_BY_SOURCE:
    'The upstream source explicitly marked this reference as rejected or mismatched the expected settlement parameters.',
  RETRY_EXHAUSTED:
    'All configured retry attempts were exhausted without confirming the reference. Escalate to manual reconciliation or requeue once upstream recovers.',
};

class ProbeClassificationError extends Error {
  constructor(
    public readonly code: ExternalVerificationFailureCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ProbeClassificationError';
  }
}

function validateReferenceInput(input: ExternalReferenceInput): void {
  if (!input || typeof input !== 'object') {
    throw new ProbeClassificationError(
      'REFERENCE_MALFORMED_INPUT',
      'External reference input must be an object.',
      false
    );
  }
  if (!input.referenceId || typeof input.referenceId !== 'string' || input.referenceId.trim().length === 0) {
    throw new ProbeClassificationError(
      'REFERENCE_MALFORMED_INPUT',
      'referenceId must be a non-empty string.',
      false
    );
  }
  if (!input.invoiceId || typeof input.invoiceId !== 'string' || input.invoiceId.trim().length === 0) {
    throw new ProbeClassificationError(
      'REFERENCE_MALFORMED_INPUT',
      'invoiceId must be a non-empty string.',
      false
    );
  }
  if (!EXTERNAL_REFERENCE_TYPES.includes(input.referenceType)) {
    throw new ProbeClassificationError(
      'REFERENCE_MALFORMED_INPUT',
      `Unsupported referenceType '${String(input.referenceType)}'.`,
      false
    );
  }
  if (!input.externalIdentifier || typeof input.externalIdentifier !== 'string') {
    throw new ProbeClassificationError(
      'REFERENCE_MALFORMED_INPUT',
      'externalIdentifier must be a non-empty string.',
      false
    );
  }
  if (input.referenceType === 'stellar_transaction') {
    if (!STELLAR_TX_HASH_REGEX.test(input.externalIdentifier)) {
      throw new ProbeClassificationError(
        'REFERENCE_MALFORMED_INPUT',
        'stellar_transaction externalIdentifier must be a 64-character hexadecimal transaction hash.',
        false
      );
    }
  } else if (!SAFE_EXTERNAL_ID_REGEX.test(input.externalIdentifier)) {
    throw new ProbeClassificationError(
      'REFERENCE_MALFORMED_INPUT',
      'externalIdentifier must be 3-256 characters of alphanumeric, dot, underscore, colon, or hyphen.',
      false
    );
  }
}

function validateAndNormalizeProbeOutput(
  raw: unknown,
  input: ExternalReferenceInput,
  now: Date,
  maxStalenessMs: number,
  allowedClockSkewMs: number,
  latencyMs: number
): PersistedSourceMetadata {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProbeClassificationError(
      'MALFORMED_SOURCE_RESPONSE',
      'External source returned a non-object payload.',
      false
    );
  }

  const obj = raw as Record<string, unknown>;
  const status = obj.status;
  if (status !== 'verified' && status !== 'pending' && status !== 'rejected') {
    throw new ProbeClassificationError(
      'MALFORMED_SOURCE_RESPONSE',
      `External source returned invalid status '${String(status)}'. Expected 'verified', 'pending', or 'rejected'.`,
      false
    );
  }

  if (typeof obj.observedTimestamp !== 'string' || obj.observedTimestamp.trim().length === 0) {
    throw new ProbeClassificationError(
      'MALFORMED_SOURCE_RESPONSE',
      'External source response is missing required ISO-8601 observedTimestamp.',
      false
    );
  }

  const observedMs = Date.parse(obj.observedTimestamp);
  if (Number.isNaN(observedMs)) {
    throw new ProbeClassificationError(
      'MALFORMED_SOURCE_RESPONSE',
      `External source observedTimestamp '${obj.observedTimestamp}' is not a valid timestamp.`,
      false
    );
  }

  const nowMs = now.getTime();
  if (observedMs > nowMs + allowedClockSkewMs) {
    throw new ProbeClassificationError(
      'STALE_SOURCE_DATA',
      `External source timestamp (${obj.observedTimestamp}) is post-dated beyond allowed clock skew.`,
      false
    );
  }
  if (nowMs - observedMs > maxStalenessMs) {
    throw new ProbeClassificationError(
      'STALE_SOURCE_DATA',
      `External source timestamp (${obj.observedTimestamp}) is older than the maximum staleness window (${maxStalenessMs}ms).`,
      false
    );
  }

  if (status === 'pending') {
    throw new ProbeClassificationError(
      'REFERENCE_PENDING_UPSTREAM',
      `External reference '${input.externalIdentifier}' is still pending upstream confirmation.`,
      true
    );
  }

  if (status === 'rejected') {
    throw new ProbeClassificationError(
      'REFERENCE_REJECTED_BY_SOURCE',
      `External reference '${input.externalIdentifier}' was explicitly rejected by source '${input.sourceSystem}'.`,
      false
    );
  }

  let ledgerSequence: number | null = null;
  if (input.referenceType === 'stellar_transaction') {
    if (
      typeof obj.ledgerSequence !== 'number' ||
      !Number.isSafeInteger(obj.ledgerSequence) ||
      obj.ledgerSequence <= 0
    ) {
      throw new ProbeClassificationError(
        'MALFORMED_SOURCE_RESPONSE',
        'stellar_transaction verification response must include a positive integer ledgerSequence.',
        false
      );
    }
    ledgerSequence = obj.ledgerSequence;
  } else if (obj.ledgerSequence !== undefined && obj.ledgerSequence !== null) {
    if (typeof obj.ledgerSequence !== 'number' || !Number.isSafeInteger(obj.ledgerSequence)) {
      throw new ProbeClassificationError(
        'MALFORMED_SOURCE_RESPONSE',
        'ledgerSequence must be an integer when provided.',
        false
      );
    }
    ledgerSequence = obj.ledgerSequence;
  }

  let settledAmount: string | null = null;
  if (obj.settledAmount !== undefined && obj.settledAmount !== null) {
    const parsedAmt = Number(obj.settledAmount);
    if (!Number.isFinite(parsedAmt) || parsedAmt <= 0) {
      throw new ProbeClassificationError(
        'MALFORMED_SOURCE_RESPONSE',
        `External source returned invalid settledAmount '${String(obj.settledAmount)}'.`,
        false
      );
    }
    settledAmount = parsedAmt.toFixed(7);
    if (input.expectedAmount !== undefined && Math.abs(parsedAmt - input.expectedAmount) > 0.0000001) {
      throw new ProbeClassificationError(
        'REFERENCE_REJECTED_BY_SOURCE',
        `External source settledAmount (${parsedAmt}) does not match expectedAmount (${input.expectedAmount}).`,
        false
      );
    }
  }

  let assetCode: string | null = null;
  if (obj.assetCode !== undefined && obj.assetCode !== null) {
    if (typeof obj.assetCode !== 'string' || obj.assetCode.trim().length === 0) {
      throw new ProbeClassificationError(
        'MALFORMED_SOURCE_RESPONSE',
        'External source assetCode must be a non-empty string.',
        false
      );
    }
    assetCode = obj.assetCode.trim().toUpperCase();
    if (
      input.expectedAssetCode &&
      assetCode !== input.expectedAssetCode.trim().toUpperCase()
    ) {
      throw new ProbeClassificationError(
        'REFERENCE_REJECTED_BY_SOURCE',
        `External source assetCode (${assetCode}) does not match expectedAssetCode (${input.expectedAssetCode}).`,
        false
      );
    }
  }

  return {
    sourceSystem: typeof obj.sourceSystem === 'string' && obj.sourceSystem.trim() ? obj.sourceSystem.trim() : input.sourceSystem,
    endpoint: input.endpoint ?? null,
    observedTimestamp: new Date(observedMs).toISOString(),
    verifiedAt: now.toISOString(),
    ledgerSequence,
    settledAmount,
    assetCode,
    rawStatus: typeof obj.rawStatus === 'string' ? obj.rawStatus : 'verified',
    responseLatencyMs: latencyMs,
    schemaVersion: typeof obj.schemaVersion === 'string' ? obj.schemaVersion : '1.0',
  };
}

async function runWithTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new ProbeClassificationError(
          'SOURCE_TIMEOUT',
          `External verification probe timed out after ${timeoutMs}ms.`,
          true
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyThrownProbeError(err: unknown): ProbeClassificationError {
  if (err instanceof ProbeClassificationError) {
    return err;
  }
  const obj = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const code = String(obj.code || '');
  const msg = typeof obj.message === 'string' ? obj.message : String(err);

  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR' || /timeout|timed out|aborted/i.test(msg)) {
    return new ProbeClassificationError('SOURCE_TIMEOUT', msg || 'External probe timed out.', true);
  }
  if (code === 'MALFORMED_SOURCE_RESPONSE' || /malformed|invalid json|unexpected token/i.test(msg)) {
    return new ProbeClassificationError('MALFORMED_SOURCE_RESPONSE', msg, false);
  }
  if (code === 'STALE_SOURCE_DATA') {
    return new ProbeClassificationError('STALE_SOURCE_DATA', msg, false);
  }
  if (code === 'REFERENCE_REJECTED_BY_SOURCE') {
    return new ProbeClassificationError('REFERENCE_REJECTED_BY_SOURCE', msg, false);
  }

  return new ProbeClassificationError(
    'SOURCE_UNREACHABLE',
    msg || 'External reference verification source is unreachable.',
    true
  );
}

/**
 * Stateful service that verifies external references with bounded timeouts,
 * exponential backoff retries, staleness/schema guards, and persistent metadata.
 */
export class ExternalReferenceVerificationService {
  private readonly records = new Map<string, ExternalReferenceRecord>();
  private readonly retryPolicy: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly maxStalenessMs: number;
  private readonly allowedClockSkewMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ExternalReferenceVerifierOptions = {}) {
    this.retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 3,
      baseDelayMs: 500,
      backoffFactor: 2,
      maxDelayMs: 10_000,
      ...options.retryPolicy,
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStalenessMs = options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;
    this.allowedClockSkewMs = options.allowedClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))));
  }

  private getOrCreateRecord(input: ExternalReferenceInput): ExternalReferenceRecord {
    const existing = this.records.get(input.referenceId);
    if (existing) return existing;

    const nowIso = this.now().toISOString();
    const record: ExternalReferenceRecord = {
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      invoiceId: input.invoiceId,
      externalIdentifier: input.externalIdentifier,
      sourceSystem: input.sourceSystem,
      endpoint: input.endpoint ?? null,
      expectedAmount: input.expectedAmount ?? null,
      expectedAssetCode: input.expectedAssetCode ?? null,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: this.retryPolicy.maxAttempts,
      verifiedAt: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      sourceMetadata: null,
      failure: null,
      attemptHistory: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.records.set(record.referenceId, record);
    return record;
  }

  /**
   * Executes a single verification attempt and updates the persisted record.
   */
  async verifySingleAttempt(
    input: ExternalReferenceInput,
    probe: ExternalReferenceProbe
  ): Promise<ExternalReferenceRecord> {
    const record = this.getOrCreateRecord(input);
    const attemptStart = this.now();
    const attemptNumber = record.attempts + 1;

    try {
      validateReferenceInput(input);
    } catch (validationErr) {
      const classified = classifyThrownProbeError(validationErr);
      const completedAt = this.now();
      record.attempts = attemptNumber;
      record.lastAttemptAt = completedAt.toISOString();
      record.updatedAt = completedAt.toISOString();
      record.status = 'FAILED_TERMINAL';
      record.nextRetryAt = null;
      record.failure = {
        code: classified.code,
        message: classified.message,
        retryable: false,
        recoveryHint: RECOVERY_HINTS[classified.code],
        attempt: attemptNumber,
        failedAt: completedAt.toISOString(),
      };
      record.attemptHistory.push({
        attempt: attemptNumber,
        startedAt: attemptStart.toISOString(),
        completedAt: completedAt.toISOString(),
        latencyMs: Math.max(0, completedAt.getTime() - attemptStart.getTime()),
        outcome: 'terminal_failure',
        errorCode: classified.code,
        message: classified.message,
      });
      return structuredClone(record);
    }

    try {
      const rawResponse = await runWithTimeout(this.timeoutMs, (signal) =>
        probe(input, signal, attemptNumber)
      );
      const completedAt = this.now();
      const latencyMs = Math.max(0, completedAt.getTime() - attemptStart.getTime());

      const metadata = validateAndNormalizeProbeOutput(
        rawResponse,
        input,
        completedAt,
        this.maxStalenessMs,
        this.allowedClockSkewMs,
        latencyMs
      );

      record.attempts = attemptNumber;
      record.lastAttemptAt = completedAt.toISOString();
      record.updatedAt = completedAt.toISOString();
      record.status = 'VERIFIED';
      record.verifiedAt = completedAt.toISOString();
      record.nextRetryAt = null;
      record.sourceMetadata = metadata;
      record.failure = null;
      record.attemptHistory.push({
        attempt: attemptNumber,
        startedAt: attemptStart.toISOString(),
        completedAt: completedAt.toISOString(),
        latencyMs,
        outcome: 'verified',
      });

      return structuredClone(record);
    } catch (err) {
      const classified = classifyThrownProbeError(err);
      const completedAt = this.now();
      const latencyMs = Math.max(0, completedAt.getTime() - attemptStart.getTime());

      record.attempts = attemptNumber;
      record.lastAttemptAt = completedAt.toISOString();
      record.updatedAt = completedAt.toISOString();

      const canRetry = classified.retryable && attemptNumber < record.maxAttempts;

      if (canRetry) {
        const delayMs = computeBackoffMs(this.retryPolicy, attemptNumber);
        const nextRetry = new Date(completedAt.getTime() + delayMs);
        record.status = 'RETRY_SCHEDULED';
        record.nextRetryAt = nextRetry.toISOString();
        record.failure = {
          code: classified.code,
          message: classified.message,
          retryable: true,
          recoveryHint: RECOVERY_HINTS[classified.code],
          attempt: attemptNumber,
          failedAt: completedAt.toISOString(),
        };
        record.attemptHistory.push({
          attempt: attemptNumber,
          startedAt: attemptStart.toISOString(),
          completedAt: completedAt.toISOString(),
          latencyMs,
          outcome: 'retry_scheduled',
          errorCode: classified.code,
          message: classified.message,
        });
      } else {
        const terminalCode: ExternalVerificationFailureCode =
          classified.retryable && attemptNumber >= record.maxAttempts
            ? 'RETRY_EXHAUSTED'
            : classified.code;

        record.status = 'FAILED_TERMINAL';
        record.nextRetryAt = null;
        record.failure = {
          code: terminalCode,
          ...(terminalCode === 'RETRY_EXHAUSTED' ? { rootCauseCode: classified.code } : {}),
          message:
            terminalCode === 'RETRY_EXHAUSTED'
              ? `Verification exhausted all ${record.maxAttempts} attempts. Last error (${classified.code}): ${classified.message}`
              : classified.message,
          retryable: false,
          recoveryHint: RECOVERY_HINTS[terminalCode],
          attempt: attemptNumber,
          failedAt: completedAt.toISOString(),
        };
        record.attemptHistory.push({
          attempt: attemptNumber,
          startedAt: attemptStart.toISOString(),
          completedAt: completedAt.toISOString(),
          latencyMs,
          outcome: 'terminal_failure',
          errorCode: terminalCode,
          message: record.failure.message,
        });
      }

      return structuredClone(record);
    }
  }

  /**
   * Verifies an external reference with automatic backoff retries until it either
   * becomes `VERIFIED` or reaches `FAILED_TERMINAL`.
   */
  async verifyWithRetries(
    input: ExternalReferenceInput,
    probe: ExternalReferenceProbe
  ): Promise<ExternalReferenceRecord> {
    let result = await this.verifySingleAttempt(input, probe);
    while (result.status === 'RETRY_SCHEDULED') {
      const delayMs = computeBackoffMs(this.retryPolicy, result.attempts);
      await this.sleep(delayMs);
      result = await this.verifySingleAttempt(input, probe);
    }
    return result;
  }

  getRecord(referenceId: string): ExternalReferenceRecord | null {
    const found = this.records.get(referenceId);
    return found ? structuredClone(found) : null;
  }

  listByInvoice(invoiceId: string): ExternalReferenceRecord[] {
    return [...this.records.values()]
      .filter((r) => r.invoiceId === invoiceId)
      .map((r) => structuredClone(r));
  }

  listAll(filter?: { status?: ExternalVerificationStatus }): ExternalReferenceRecord[] {
    return [...this.records.values()]
      .filter((r) => !filter?.status || r.status === filter.status)
      .map((r) => structuredClone(r));
  }

  clear(): void {
    this.records.clear();
  }
}

export const defaultExternalReferenceVerifier = new ExternalReferenceVerificationService();
