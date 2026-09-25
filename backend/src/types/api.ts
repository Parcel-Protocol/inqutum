import { Response } from 'express';
import type { VerificationCode } from '../services/payment-verification';

// Shared response envelope used by both the MVP and the Postgres server.
// Both servers send the same success/failure shape so clients stay
// storage-agnostic: a frontend pointed at server-mvp.ts behaves exactly the
// same against server.ts (only persistence duration changes).
// sendSuccess / sendFailure wrap this envelope; they are shared helpers, so
// HTTP status codes and envelope keys are also pinned across backends.
export interface ApiPagination {
  limit: number;
  offset: number;
  total: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
  code?: string;
  warning?: string;
  pagination?: ApiPagination;
}

/**
 * Stable machine-readable codes for failures that are not payment-verification
 * rejections. Clients branch on these, never on the human-readable `error`.
 */
export type ApiErrorCode =
  | 'INVALID_TRANSITION'
  | 'INVOICE_NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'IDEMPOTENCY_KEY_EXPIRED'
  | 'IDEMPOTENCY_IN_PROGRESS';

export interface ApiFailure {
  success: false;
  error: string;
  code?: VerificationCode | ApiErrorCode;
  /** Extra structured context for the code, e.g. `{ from, to }` for INVALID_TRANSITION. */
  details?: Record<string, unknown>;
}

export interface CancelInvoiceInput {
  sellerPublicKey?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(
  data: T,
  extra?: { message?: string; code?: string; warning?: string; pagination?: ApiPagination }
): ApiSuccess<T> {
  const body: ApiSuccess<T> = { success: true, data };

  if (extra?.message) {
    body.message = extra.message;
  }
  if (extra?.code) {
    body.code = extra.code;
  }
  if (extra?.warning) {
    body.warning = extra.warning;
  }
  if (extra?.pagination) {
    body.pagination = extra.pagination;
  }

  return body;
}

export function apiFailure(error: string): ApiFailure {
  return { success: false, error };
}

export function sendSuccess<T>(
  res: Response,
  status: number,
  data: T,
  extra?: { message?: string; code?: string; warning?: string; pagination?: ApiPagination }
): void {
  res.status(status).json(apiSuccess(data, extra));
}

export function sendFailure(
  res: Response,
  status: number,
  error: string,
  code?: ApiFailure['code'],
  details?: ApiFailure['details']
): void {
  const body = apiFailure(error);
  if (code) body.code = code;
  if (details) body.details = details;
  res.status(status).json(body);
}

export function sendVerificationFailure(
  res: Response,
  status: number,
  code: VerificationCode,
  error: string
): void {
  res.status(status).json({ success: false, code, error });
}

/**
 * The envelope a verification rejection is returned in.
 *
 * `success` is the literal `false` rather than `boolean` so this discriminates
 * from a success envelope at the type level instead of only at runtime.
 */
export interface VerificationFailureBody {
  success: false;
  code: VerificationCode;
  error: string;
}

/** Build a verification failure envelope with a stable code and its message. */
export function verificationFailureBody(
  code: VerificationCode,
  error: string
): VerificationFailureBody {
  return { success: false, code, error };
}

export default {
  apiSuccess,
  apiFailure,
  sendSuccess,
  sendFailure,
  verificationFailureBody,
};
