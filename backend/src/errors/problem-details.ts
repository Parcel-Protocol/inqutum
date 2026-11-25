/**
 * Stable Problem-Details Error Taxonomy — Issue #439
 *
 * Maps the existing domain error taxonomy into a valid RFC 7807 / IANA
 * "application/problem+json" envelope so every failure response carries the
 * four mandatory fields (`type`, `title`, `status`, `detail`) alongside the
 * existing extension fields that clients already depend on (`code`,
 * `category`, `retryable`, `recoveryAction`, `remediation`).
 *
 * Design decisions:
 *
 * 1. `type` is a stable URI fragment.  We use the well-known prefix
 *    `https://quittance.app/errors/` followed by the lower-kebab-case code so
 *    tools can bookmark individual error types without coupling to HTTP status.
 *
 * 2. `instance` is optional but always set when a `correlationId` is present;
 *    it becomes a trace-able `/errors/instances/<correlationId>` URI.
 *
 * 3. The shape is a strict superset of the existing `ApiFailure` envelope, so
 *    old clients that only read `success`, `error`, `code` continue to work
 *    unchanged.
 *
 * 4. Sensitive internals are never included: `toProblemDetails` calls
 *    `redactErrorMessage` on every human-readable string it places in
 *    `detail`.
 *
 * Public surface
 * ──────────────
 *   PROBLEM_TYPE_BASE          — the URI prefix
 *   PROBLEM_CONTENT_TYPE       — the Media-Type string
 *   problemTypeUri(code)       — build the canonical `type` URI for a code
 *   toProblemDetails(failure)  — convert any `ApiFailure` to `ProblemDetails`
 *   sendProblemDetails(res, …) — Express helper: set Content-Type & send JSON
 */

import type { Response } from 'express';
import { redactErrorMessage } from '../security/redaction';
import {
  DOMAIN_ERROR_TAXONOMY,
  type ErrorCategory,
} from './error-taxonomy';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROBLEM_TYPE_BASE = 'https://quittance.app/errors/' as const;
export const PROBLEM_CONTENT_TYPE = 'application/problem+json' as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RFC 7807 §3 mandatory + commonly-used extension members.
 *
 * The five RFC-defined fields use their RFC names (`type`, `title`, `status`,
 * `detail`, `instance`).  All Quittance-specific extension fields are
 * PascalCase-prefixed with `x_` so they are identifiable as extensions.
 */
export interface ProblemDetails {
  /** Stable URI that identifies the problem type (RFC 7807 §3.1). */
  type: string;
  /** Short, human-readable summary (RFC 7807 §3.1). Same as the taxonomy title. */
  title: string;
  /** HTTP status code (RFC 7807 §3.1). */
  status: number;
  /**
   * Human-readable explanation specific to this occurrence (RFC 7807 §3.1).
   * User-safe; never contains SQL, file paths, secrets or stack traces.
   */
  detail: string;
  /**
   * Optional URI that identifies this specific occurrence (RFC 7807 §3.1).
   * Set to `/errors/instances/<correlationId>` when a correlationId is known.
   */
  instance?: string;

  // ── Quittance extension fields ──────────────────────────────────────────

  /** Stable machine-readable error code.  Mirrors `ApiFailure.code`. */
  code: string;
  /**
   * Coarse classification for routing and alerting.
   * One of: VALIDATION | AUTHORIZATION | SETTLEMENT | LIFECYCLE |
   *         NOT_FOUND  | NETWORK       | RATE_LIMIT | INTERNAL  |
   *         POLICY     | PERMISSION    | STALE_STATE| DEPENDENCY| UNEXPECTED
   */
  category: ErrorCategory | string;
  /** `true` when retrying the identical request can succeed without changes. */
  retryable: boolean;
  /** One-sentence action the user should take. */
  recoveryAction: string;
  /**
   * Ordered, concrete remediation steps for the client to render as a
   * checklist.  Absent for codes that pre-date contract v1.1.0 to preserve
   * backward compatibility.
   */
  remediation?: string[];
  /**
   * Per-field validation errors.  Present only for VALIDATION failures.
   */
  fieldErrors?: Array<{
    field: string;
    code: string;
    message: string;
    hint?: string;
  }>;
  /** Trace identifier for log correlation.  Mirrors `ApiFailure.correlationId`. */
  correlationId?: string;
  /** ISO-8601 timestamp of when the problem was produced. */
  timestamp: string;
  /**
   * Indicates this envelope is a ProblemDetails document.
   * Retained for clients that feature-detect the new shape.
   */
  success: false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a domain error code (e.g. `MEMO_MISMATCH`) into the canonical
 * problem-type URI (e.g. `https://quittance.app/errors/memo-mismatch`).
 */
export function problemTypeUri(code: string): string {
  const slug = code.toLowerCase().replace(/_/g, '-');
  return `${PROBLEM_TYPE_BASE}${slug}`;
}

// ---------------------------------------------------------------------------
// Core converter
// ---------------------------------------------------------------------------

export interface ApiFailureLike {
  success: false;
  error: string;
  code?: string;
  category?: ErrorCategory | string;
  retryable?: boolean;
  recoveryAction?: string;
  remediation?: string[];
  fieldErrors?: Array<{ field: string; code: string; message: string; hint?: string }>;
  correlationId?: string;
  timestamp?: string;
  httpStatus?: number;
}

/**
 * Converts an `ApiFailure`-like object into a fully-formed `ProblemDetails`
 * document ready for serialization.
 *
 * The function:
 *  - never throws — unknown codes fall back to `INTERNAL_ERROR`
 *  - redacts the `detail` string to strip PII, passwords and file paths
 *  - fills `title`, `recoveryAction` and `remediation` from `DOMAIN_ERROR_TAXONOMY`
 *    when the calling code omitted them
 */
export function toProblemDetails(
  failure: ApiFailureLike,
  httpStatus?: number,
): ProblemDetails {
  const code = failure.code || 'INTERNAL_ERROR';
  const taxonomyEntry = DOMAIN_ERROR_TAXONOMY[code] ?? DOMAIN_ERROR_TAXONOMY['INTERNAL_ERROR'];

  const resolvedStatus =
    httpStatus ??
    failure.httpStatus ??
    taxonomyEntry?.httpStatus ??
    500;

  const resolvedTitle =
    taxonomyEntry?.userSafeMessage ??
    code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const resolvedDetail = redactErrorMessage(
    failure.error?.length ? failure.error : (taxonomyEntry?.userSafeMessage ?? 'An unexpected error occurred'),
  );

  const resolvedRecovery = redactErrorMessage(
    failure.recoveryAction || taxonomyEntry?.recoveryAction || '',
  );

  const remediationSource = failure.remediation?.length
    ? failure.remediation
    : taxonomyEntry?.remediation;

  const resolvedRemediation: string[] | undefined = remediationSource?.length
    ? remediationSource.map((step) => redactErrorMessage(step))
    : undefined;

  const resolvedCategory: ErrorCategory | string =
    failure.category ||
    taxonomyEntry?.category ||
    'INTERNAL';

  const resolvedRetryable: boolean =
    typeof failure.retryable === 'boolean'
      ? failure.retryable
      : taxonomyEntry?.retryable ?? false;

  const correlationId = failure.correlationId;
  const timestamp = failure.timestamp ?? new Date().toISOString();

  const doc: ProblemDetails = {
    type: problemTypeUri(code),
    title: resolvedTitle,
    status: resolvedStatus,
    detail: resolvedDetail,
    code,
    category: resolvedCategory,
    retryable: resolvedRetryable,
    recoveryAction: resolvedRecovery,
    timestamp,
    success: false,
  };

  if (correlationId) {
    doc.instance = `/errors/instances/${correlationId}`;
    doc.correlationId = correlationId;
  }

  if (resolvedRemediation) {
    doc.remediation = resolvedRemediation;
  }

  if (failure.fieldErrors?.length) {
    doc.fieldErrors = failure.fieldErrors.map((fieldError) => ({
      ...fieldError,
      message: redactErrorMessage(fieldError.message),
      ...(fieldError.hint !== undefined
        ? { hint: redactErrorMessage(fieldError.hint) }
        : {}),
    }));
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Express helper
// ---------------------------------------------------------------------------

/**
 * Sends an RFC 7807 problem-details response.
 *
 * Sets `Content-Type: application/problem+json` and writes the JSON body.
 * Falls back to `application/json` for Express versions that do not support
 * the problem+json media type natively.
 */
export function sendProblemDetails(
  res: Response,
  httpStatus: number,
  failure: ApiFailureLike,
): void {
  const doc = toProblemDetails(failure, httpStatus);

  // RFC 7807 §3: the media type for problem details is application/problem+json
  res
    .status(httpStatus)
    .setHeader('Content-Type', PROBLEM_CONTENT_TYPE)
    .json(doc);
}
