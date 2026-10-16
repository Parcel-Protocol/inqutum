/**
 * Structured Domain Error Taxonomy for Quittance.
 *
 * Defines standardized error categories, domain error codes, HTTP status mappings,
 * retryability metadata, user-safe error messages, and actionable recovery guidance.
 */

import { VerificationCode, VERIFICATION_MESSAGES } from '../services/payment-verification';

export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTHORIZATION'
  | 'SETTLEMENT'
  | 'LIFECYCLE'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'INTERNAL';

export interface DomainErrorDefinition {
  code: string;
  category: ErrorCategory;
  httpStatus: number;
  retryable: boolean;
  userSafeMessage: string;
  recoveryAction: string;
}

/**
 * Canonical taxonomy mapping for all verification codes and domain errors.
 */
export const DOMAIN_ERROR_TAXONOMY: Record<string, DomainErrorDefinition> = {
  // --- Settlement / Verification Codes ---
  MISSING_TX_HASH: {
    code: 'MISSING_TX_HASH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.MISSING_TX_HASH,
    recoveryAction: 'Provide a 64-character transaction hash from your Stellar wallet after submitting payment.',
  },
  INVALID_TX_HASH: {
    code: 'INVALID_TX_HASH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVALID_TX_HASH,
    recoveryAction: 'Verify that the transaction hash contains exactly 64 hexadecimal characters.',
  },
  INVALID_PAYER_NAME: {
    code: 'INVALID_PAYER_NAME',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVALID_PAYER_NAME,
    recoveryAction: 'Enter a valid text string for the payer name or leave it empty.',
  },
  INVALID_PAYER_EMAIL: {
    code: 'INVALID_PAYER_EMAIL',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVALID_PAYER_EMAIL,
    recoveryAction: 'Enter a valid email address (e.g. name@domain.com) or leave it empty.',
  },
  PAYER_INFO_TOO_LONG: {
    code: 'PAYER_INFO_TOO_LONG',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.PAYER_INFO_TOO_LONG,
    recoveryAction: 'Shorten payer name and email to under 255 characters.',
  },
  INVOICE_ALREADY_PAID: {
    code: 'INVOICE_ALREADY_PAID',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVOICE_ALREADY_PAID,
    recoveryAction: 'This invoice is already settled. You can download or email your quittance proof.',
  },
  INVOICE_EXPIRED: {
    code: 'INVOICE_EXPIRED',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVOICE_EXPIRED,
    recoveryAction: 'The payment window has elapsed. Contact the seller to issue a new invoice.',
  },
  INVOICE_NOT_PENDING: {
    code: 'INVOICE_NOT_PENDING',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.INVOICE_NOT_PENDING,
    recoveryAction: 'Only pending invoices can accept payment. Check invoice status on dashboard.',
  },
  TRANSACTION_NOT_FOUND: {
    code: 'TRANSACTION_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: true,
    userSafeMessage: VERIFICATION_MESSAGES.TRANSACTION_NOT_FOUND,
    recoveryAction: 'Stellar ledger close takes ~5 seconds. Please wait a moment and retry verification.',
  },
  NO_PAYMENT_OPERATION: {
    code: 'NO_PAYMENT_OPERATION',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.NO_PAYMENT_OPERATION,
    recoveryAction: 'Ensure your transaction contains a direct payment operation to the seller address.',
  },
  MEMO_MISMATCH: {
    code: 'MEMO_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.MEMO_MISMATCH,
    recoveryAction: 'Include the exact invoice memo in your transaction memo field before sending.',
  },
  DESTINATION_MISMATCH: {
    code: 'DESTINATION_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.DESTINATION_MISMATCH,
    recoveryAction: 'Send funds directly to the seller public key specified in the invoice.',
  },
  AMOUNT_MISMATCH: {
    code: 'AMOUNT_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.AMOUNT_MISMATCH,
    recoveryAction: 'Send the exact invoice amount (matched at Stellar 7-decimal stroop precision).',
  },
  ASSET_MISMATCH: {
    code: 'ASSET_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.ASSET_MISMATCH,
    recoveryAction: 'Pay with the designated asset. For non-native tokens, verify both asset code and issuer.',
  },
  NETWORK_MISMATCH: {
    code: 'NETWORK_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: VERIFICATION_MESSAGES.NETWORK_MISMATCH,
    recoveryAction: 'Switch your Freighter wallet to the matching Stellar network (Testnet or Public).',
  },

  // --- General Domain Errors ---
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Invalid input provided',
    recoveryAction: 'Review the input parameters, ensuring valid numbers, addresses, and formats.',
  },
  SELLER_REQUIRED: {
    code: 'SELLER_REQUIRED',
    category: 'AUTHORIZATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'sellerPublicKey query parameter is required',
    recoveryAction: 'Connect your Freighter wallet to supply the seller public key.',
  },
  UNAUTHORIZED_SELLER: {
    code: 'UNAUTHORIZED_SELLER',
    category: 'AUTHORIZATION',
    httpStatus: 403,
    retryable: false,
    userSafeMessage: 'You are not authorized to modify this invoice',
    recoveryAction: 'Connect the Freighter wallet that created this invoice.',
  },
  INVOICE_NOT_FOUND: {
    code: 'INVOICE_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'Invoice not found',
    recoveryAction: 'Check the invoice ID in the URL and ensure it has not been deleted.',
  },
  INVOICE_CANNOT_CANCEL: {
    code: 'INVOICE_CANNOT_CANCEL',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Only pending invoices can be cancelled',
    recoveryAction: 'Invoices that are already paid or expired cannot be cancelled.',
  },
  CORS_ORIGIN_DENIED: {
    code: 'CORS_ORIGIN_DENIED',
    category: 'AUTHORIZATION',
    httpStatus: 403,
    retryable: false,
    userSafeMessage: 'Origin is not allowed by Quittance CORS policy',
    recoveryAction: 'Configure the frontend origin in FRONTEND_URL environment variables.',
  },
  HORIZON_UNAVAILABLE: {
    code: 'HORIZON_UNAVAILABLE',
    category: 'NETWORK',
    httpStatus: 503,
    retryable: true,
    userSafeMessage: 'Stellar Horizon is temporarily unreachable',
    recoveryAction: 'Stellar network is experiencing a transient delay. Please retry in a few seconds.',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    category: 'RATE_LIMIT',
    httpStatus: 429,
    retryable: true,
    userSafeMessage: 'Too many requests. Please slow down.',
    recoveryAction: 'Wait a few seconds before retrying the operation.',
  },
  CONFLICT: {
    code: 'CONFLICT',
    category: 'LIFECYCLE',
    httpStatus: 409,
    retryable: true,
    userSafeMessage: 'Invoice was modified by another session. Please refresh and try again.',
    recoveryAction: 'Refresh the invoice to get the latest version, then retry the operation.',
  },
  NOT_FOUND: {
    code: 'NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'Endpoint not found',
    recoveryAction: 'Check the request method and path against docs/API_CONTRACTS.md.',
  },
  INVALID_STATUS: {
    code: 'INVALID_STATUS',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Unknown status filter',
    recoveryAction: 'Use one of the status values listed in the error message.',
  },
  INVALID_CURSOR: {
    code: 'INVALID_CURSOR',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Pagination cursor is not valid',
    recoveryAction: 'Drop the cursor parameter and restart from the first page.',
  },
  INVOICE_NOT_PAID: {
    code: 'INVOICE_NOT_PAID',
    category: 'LIFECYCLE',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'This action is only available for PAID invoices',
    recoveryAction: 'Wait until payment is verified, or use the payment_request template instead.',
  },
  RECIPIENT_EMAIL_REQUIRED: {
    code: 'RECIPIENT_EMAIL_REQUIRED',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Recipient email address is required',
    recoveryAction: 'Pass recipientEmail in the request body or set a customer email on the invoice.',
  },

  // --- Notifications ---
  RECIPIENT_REQUIRED: {
    code: 'RECIPIENT_REQUIRED',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'recipient must be a valid Stellar public key',
    recoveryAction: 'Pass the recipient wallet public key (G…, 56 characters).',
  },
  NOTIFICATION_NOT_FOUND: {
    code: 'NOTIFICATION_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'Notification not found',
    recoveryAction: 'Refresh the notification list; the item may belong to another recipient.',
  },

  // --- Exports ---
  INVALID_EXPORT_REQUEST: {
    code: 'INVALID_EXPORT_REQUEST',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Export request is not valid',
    recoveryAction: 'Fix the fields named in the error message and resubmit the export.',
  },
  REQUESTER_REQUIRED: {
    code: 'REQUESTER_REQUIRED',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'requester must be a valid Stellar public key',
    recoveryAction: 'Use the downloadPath returned when the export was created; it carries the requester.',
  },
  EXPORT_FORBIDDEN: {
    code: 'EXPORT_FORBIDDEN',
    category: 'AUTHORIZATION',
    httpStatus: 403,
    retryable: false,
    userSafeMessage: 'You are not allowed to export these records',
    recoveryAction: 'Export only invoices owned by the connected wallet.',
  },
  EXPORT_NOT_FOUND: {
    code: 'EXPORT_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'Export not found',
    recoveryAction: 'Generate a new export; export ids are only valid for the requester that created them.',
  },
  EXPORT_EXPIRED: {
    code: 'EXPORT_EXPIRED',
    category: 'LIFECYCLE',
    httpStatus: 410,
    retryable: false,
    userSafeMessage: 'This export has expired and was deleted',
    recoveryAction: 'Generate a new export.',
  },
  EXPORT_FAILED: {
    code: 'EXPORT_FAILED',
    category: 'INTERNAL',
    httpStatus: 500,
    retryable: true,
    userSafeMessage: 'Failed to generate export',
    recoveryAction: 'Retry the export. If it keeps failing, contact support with the correlation ID.',
  },

  // --- Email delivery ---
  EMAIL_REQUEST_INVALID: {
    code: 'EMAIL_REQUEST_INVALID',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Invalid email request',
    recoveryAction: 'Check the request body against the /api/email/send contract.',
  },
  EMAIL_INVALID_RECIPIENT: {
    code: 'EMAIL_INVALID_RECIPIENT',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Recipient is not a valid email address',
    recoveryAction: 'Check the recipient address and try again.',
  },
  EMAIL_AUTH_FAILED: {
    code: 'EMAIL_AUTH_FAILED',
    category: 'NETWORK',
    httpStatus: 502,
    retryable: false,
    userSafeMessage: 'The email provider rejected our credentials',
    recoveryAction: 'The email provider rejected our credentials. A maintainer must fix the provider API key or SMTP username.',
  },
  EMAIL_QUOTA_EXCEEDED: {
    code: 'EMAIL_QUOTA_EXCEEDED',
    category: 'RATE_LIMIT',
    httpStatus: 429,
    retryable: true,
    userSafeMessage: 'The email provider is rate limiting this deployment',
    recoveryAction: 'The email provider is rate limiting or out of quota. Try again later or upgrade the sending plan.',
  },
  EMAIL_TRANSIENT_FAILURE: {
    code: 'EMAIL_TRANSIENT_FAILURE',
    category: 'NETWORK',
    httpStatus: 503,
    retryable: true,
    userSafeMessage: 'The email provider is temporarily unreachable',
    recoveryAction: 'The email provider is temporarily unreachable. Try again in a few minutes.',
  },
  EMAIL_NOT_CONFIGURED: {
    code: 'EMAIL_NOT_CONFIGURED',
    category: 'NETWORK',
    httpStatus: 503,
    retryable: false,
    userSafeMessage: 'Email delivery is not configured',
    recoveryAction: 'Email delivery is not configured for this deployment. See docs/EMAIL_DELIVERY.md.',
  },
  EMAIL_FAILED: {
    code: 'EMAIL_FAILED',
    category: 'NETWORK',
    httpStatus: 502,
    retryable: false,
    userSafeMessage: 'Email delivery failed',
    recoveryAction: 'The email provider rejected this message. Check the address and content, then try again.',
  },
  EMAIL_WEBHOOK_INVALID: {
    code: 'EMAIL_WEBHOOK_INVALID',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Invalid webhook payload',
    recoveryAction: 'Provider callbacks must carry messageId and an event of bounce, complaint or delivered.',
  },
  EMAIL_DELIVERY_NOT_FOUND: {
    code: 'EMAIL_DELIVERY_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'No delivery matches that message id',
    recoveryAction: 'Confirm the provider message id; callbacks for unknown messages are ignored.',
  },

  // --- Signed webhooks ---
  MALFORMED_WEBHOOK: {
    code: 'MALFORMED_WEBHOOK',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Missing required webhook headers',
    recoveryAction: 'Send X-Webhook-Signature, X-Webhook-Timestamp and X-Webhook-Event-Id.',
  },
  STALE_TIMESTAMP: {
    code: 'STALE_TIMESTAMP',
    category: 'VALIDATION',
    httpStatus: 408,
    retryable: false,
    userSafeMessage: 'Webhook timestamp is outside the allowed window',
    recoveryAction: 'Re-sign the event with a fresh timestamp and check the sender clock.',
  },
  INVALID_SIGNATURE: {
    code: 'INVALID_SIGNATURE',
    category: 'AUTHORIZATION',
    httpStatus: 401,
    retryable: false,
    userSafeMessage: 'Webhook signature verification failed',
    recoveryAction: 'Sign the raw request body with the shared WEBHOOK_SIGNING_SECRET.',
  },
  DUPLICATE_EVENT: {
    code: 'DUPLICATE_EVENT',
    category: 'LIFECYCLE',
    httpStatus: 409,
    retryable: false,
    userSafeMessage: 'Webhook event has already been processed',
    recoveryAction: 'No action needed; the event was already applied. Do not retry it.',
  },

  // --- Admin / ops surface ---
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    category: 'AUTHORIZATION',
    httpStatus: 401,
    retryable: false,
    userSafeMessage: 'Invalid or missing admin token',
    recoveryAction: 'Send Authorization: Bearer <JOBS_ADMIN_TOKEN>.',
  },
  JOBS_ADMIN_DISABLED: {
    code: 'JOBS_ADMIN_DISABLED',
    category: 'AUTHORIZATION',
    httpStatus: 403,
    retryable: false,
    userSafeMessage: 'Job inspection is not enabled',
    recoveryAction: 'Set JOBS_ADMIN_TOKEN on the deployment to enable the admin surface.',
  },
  JOB_NOT_FOUND: {
    code: 'JOB_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'Job not found',
    recoveryAction: 'List jobs first; completed jobs may have been pruned.',
  },
  JOB_NOT_DEAD: {
    code: 'JOB_NOT_DEAD',
    category: 'LIFECYCLE',
    httpStatus: 409,
    retryable: false,
    userSafeMessage: 'Only dead-lettered jobs can be retried',
    recoveryAction: 'Wait for the job to finish or dead-letter before retrying it.',
  },
  TARGET_INVALID: {
    code: 'TARGET_INVALID',
    category: 'VALIDATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'targetId must be a valid Stellar public key',
    recoveryAction: 'Pass the target wallet public key (G…, 56 characters).',
  },
  IMPERSONATION_REJECTED: {
    code: 'IMPERSONATION_REJECTED',
    category: 'AUTHORIZATION',
    httpStatus: 400,
    retryable: false,
    userSafeMessage: 'Impersonation session rejected',
    recoveryAction: 'Supply a reason, an allowed permission set and a duration within policy limits.',
  },
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    category: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    userSafeMessage: 'No active session with that id for this maintainer',
    recoveryAction: 'The session may have already expired or been ended.',
  },

  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    category: 'INTERNAL',
    httpStatus: 500,
    retryable: true,
    userSafeMessage: 'An internal server error occurred',
    recoveryAction: 'Please retry your request. If the problem persists, contact support with the correlation ID.',
  },
};

/**
 * Typed Application Domain Error class.
 */
export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly details?: any;

  constructor(
    codeOrDef: string | DomainErrorDefinition,
    customMessage?: string,
    details?: any
  ) {
    const def =
      typeof codeOrDef === 'string'
        ? DOMAIN_ERROR_TAXONOMY[codeOrDef] || DOMAIN_ERROR_TAXONOMY.INTERNAL_ERROR
        : codeOrDef;

    super(customMessage || def.userSafeMessage);
    this.name = 'AppError';
    this.code = def.code;
    this.category = def.category;
    this.httpStatus = def.httpStatus;
    this.retryable = def.retryable;
    this.recoveryAction = def.recoveryAction;
    this.details = details;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

/**
 * Classify any error into a structured DomainErrorDefinition.
 */
export function classifyError(error: any): DomainErrorDefinition & { customMessage?: string } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      category: error.category,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      userSafeMessage: error.message,
      recoveryAction: error.recoveryAction,
    };
  }

  const code = error?.code as string | undefined;
  if (code && DOMAIN_ERROR_TAXONOMY[code]) {
    return DOMAIN_ERROR_TAXONOMY[code];
  }

  // Zod validation errors
  if (error?.name === 'ZodError' || Array.isArray(error?.issues)) {
    const firstIssue = error?.issues?.[0];
    const field = firstIssue?.path?.join('.') || 'input';
    const message = firstIssue?.message || 'Invalid input';
    return {
      ...DOMAIN_ERROR_TAXONOMY.VALIDATION_FAILED,
      customMessage: `${field}: ${message}`,
    };
  }

  // Common network / connection errors
  if (
    error?.code === 'ECONNREFUSED' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ECONNRESET' ||
    error?.message?.includes('Horizon') ||
    error?.message?.includes('network')
  ) {
    return DOMAIN_ERROR_TAXONOMY.HORIZON_UNAVAILABLE;
  }

  // Specific message heuristics
  if (typeof error?.message === 'string') {
    const msg = error.message;
    if (msg.includes('not found') || msg.includes('Invoice not found')) {
      return DOMAIN_ERROR_TAXONOMY.INVOICE_NOT_FOUND;
    }
    if (msg.includes('sellerPublicKey') || msg.includes('Seller public key')) {
      return DOMAIN_ERROR_TAXONOMY.SELLER_REQUIRED;
    }
    if (msg.includes('already processed') || msg.includes('cannot be cancelled')) {
      return DOMAIN_ERROR_TAXONOMY.INVOICE_CANNOT_CANCEL;
    }
    if (msg.includes('expired')) {
      return DOMAIN_ERROR_TAXONOMY.INVOICE_EXPIRED;
    }
  }

  return DOMAIN_ERROR_TAXONOMY.INTERNAL_ERROR;
}

/**
 * Categories whose underlying error text describes our infrastructure (hosts,
 * ports, SQL, provider responses) rather than the caller's request. For these
 * the raw `error.message` is never echoed; the taxonomy message is used.
 */
const OPAQUE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set(['INTERNAL', 'NETWORK']);

/**
 * Whether a raw error message may be shown to the caller for a classified error.
 * Explicit AppErrors carry a message chosen by the code that threw them; anything
 * else in an opaque category falls back to the canonical user-safe message.
 */
export function canEchoErrorMessage(error: any, category: ErrorCategory): boolean {
  if (error instanceof AppError) return true;
  return !OPAQUE_CATEGORIES.has(category);
}

/**
 * Build a user-safe API error response payload.
 */
export function buildUserSafeErrorResponse(
  error: any,
  correlationId?: string
): {
  success: false;
  error: string;
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  recoveryAction: string;
  correlationId?: string;
  timestamp: string;
} {
  const classified = classifyError(error);

  let userMessage = classified.userSafeMessage;
  if (classified.customMessage) {
    userMessage = classified.customMessage;
  } else if (
    canEchoErrorMessage(error, classified.category) &&
    typeof error?.message === 'string' &&
    error.message.length > 0 &&
    !error.message.includes('\n')
  ) {
    userMessage = error.message;
  }

  return {
    success: false,
    error: userMessage,
    code: classified.code,
    category: classified.category,
    retryable: classified.retryable,
    recoveryAction: classified.recoveryAction,
    ...(correlationId ? { correlationId } : {}),
    timestamp: new Date().toISOString(),
  };
}
