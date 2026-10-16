/**
 * RFC 9457 Problem Details for the Quittance/Inqutum API (#260).
 *
 * The legacy failure envelope ({ success: false, error, code, ... }) stays the
 * default so existing clients are unaffected. A client opts in to problem
 * details by sending `Accept: application/problem+json`; the middleware below
 * then rewrites every failure envelope on the way out, whichever route or
 * helper produced it. One rewrite point means a route cannot forget to
 * support the format.
 *
 * Stability rules (enforced by tests/problem-details.test.ts against
 * tests/fixtures/error-codes.lock.json):
 *   - `code` and `type` are permanent identifiers: never renamed or reused.
 *   - A code's `status`, `category` and `retryable` do not change in place.
 *     Changing them means a new code plus deprecation of the old one.
 *   - `title` is the canonical user-safe message; `detail` is the
 *     request-specific message and may change wording at any time.
 */

import type { NextFunction, Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

import { DOMAIN_ERROR_TAXONOMY, type ErrorCategory } from './error-taxonomy';

export const PROBLEM_JSON = 'application/problem+json';

/**
 * Problem type URIs are URNs: stable identifiers that do not depend on where
 * the docs are hosted. Each one is documented in docs/ERROR_CODES.md.
 */
export const PROBLEM_TYPE_PREFIX = 'urn:inqutum:problem:';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  /** Stable machine code, identical to the legacy envelope's `code`. */
  code: string;
  category?: ErrorCategory;
  retryable?: boolean;
  /** Actionable next step for the caller (legacy envelope: `recoveryAction`). */
  remediation?: string;
  correlationId?: string;
  timestamp?: string;
}

/** Shape of the legacy failure envelope as emitted by any route. */
interface FailureEnvelope {
  success: false;
  error?: unknown;
  code?: unknown;
  category?: ErrorCategory;
  retryable?: boolean;
  recoveryAction?: string;
  correlationId?: string;
  timestamp?: string;
}

export function problemTypeFor(code: string): string {
  return `${PROBLEM_TYPE_PREFIX}${code.toLowerCase().replace(/_/g, '-')}`;
}

/**
 * True when the Accept header explicitly lists application/problem+json with a
 * non-zero quality. Wildcards do not opt in: `*\/*` keeps the legacy envelope,
 * so browsers and generic HTTP clients see no change.
 */
export function wantsProblemDetails(accept: string | undefined): boolean {
  if (!accept) return false;
  return accept.split(',').some((part) => {
    const [mediaType, ...params] = part.trim().split(';');
    if (mediaType.trim().toLowerCase() !== PROBLEM_JSON) return false;
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

export function isFailureEnvelope(body: unknown): body is FailureEnvelope {
  return typeof body === 'object' && body !== null && (body as any).success === false;
}

/**
 * Convert a legacy failure envelope into a problem details document.
 *
 * Server errors (5xx) whose code is not registered are reported as
 * INTERNAL_ERROR with the canonical message, because an unregistered 5xx
 * message is the most likely place for internal detail to leak.
 */
export function toProblemDetails(envelope: FailureEnvelope, status: number, instance?: string): ProblemDetails {
  const rawCode = typeof envelope.code === 'string' ? envelope.code : undefined;
  let def = rawCode ? DOMAIN_ERROR_TAXONOMY[rawCode] : undefined;
  let detail = typeof envelope.error === 'string' && envelope.error.length > 0 ? envelope.error : undefined;

  if (!def && status >= 500) {
    def = DOMAIN_ERROR_TAXONOMY.INTERNAL_ERROR;
    detail = def.userSafeMessage;
  }

  const code = def?.code ?? rawCode ?? 'UNCLASSIFIED';
  const title = def?.userSafeMessage ?? STATUS_CODES[status] ?? 'Error';

  const problem: ProblemDetails = {
    type: def ? problemTypeFor(def.code) : 'about:blank',
    title,
    status,
    detail: detail ?? title,
    code,
  };

  if (instance) problem.instance = instance;

  const category = envelope.category ?? def?.category;
  if (category) problem.category = category;

  const retryable = envelope.retryable ?? def?.retryable;
  if (retryable !== undefined) problem.retryable = retryable;

  const remediation = envelope.recoveryAction ?? def?.recoveryAction;
  if (remediation) problem.remediation = remediation;

  if (envelope.correlationId) problem.correlationId = envelope.correlationId;
  problem.timestamp = envelope.timestamp ?? new Date().toISOString();

  return problem;
}

/**
 * Express middleware: when the client asks for problem details, rewrite any
 * failure envelope sent with a 4xx/5xx status. Success bodies and raw
 * (non-envelope) responses pass through untouched. Mount it before routes.
 */
export function problemDetailsNegotiation() {
  return (req: Request, res: Response, next: NextFunction) => {
    const wantsProblem = wantsProblemDetails(req.get('accept'));
    const json = res.json.bind(res);

    res.json = (body?: any) => {
      if (res.statusCode >= 400 && isFailureEnvelope(body)) {
        // The representation of an error depends on Accept, so shared caches
        // must not serve one client's format to another.
        res.vary('Accept');
        if (wantsProblem) {
          res.type(PROBLEM_JSON);
          return json(toProblemDetails(body, res.statusCode, req.originalUrl.split('?')[0]));
        }
      }
      return json(body);
    };

    next();
  };
}
