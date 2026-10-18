/**
 * User-Facing Explanation Framework for Rejected Operations.
 *
 * Maps low-level validation failures, business policy denials, permission/auth
 * errors, optimistic lock / stale-state conflicts, settlement mismatches, and
 * unexpected system failures into a single deterministic, user-safe
 * `RejectionExplanation` contract.
 *
 * Guarantees:
 *  - Every expected rejection has a stable `reasonCode` and `category`.
 *  - Actionable, ordered `recoveryHints` tell the user or client how to recover.
 *  - Sensitive internals (SQL errors, stack traces, secrets, file paths, PII)
 *    are stripped and never exposed to clients.
 */

import { redactErrorMessage, sanitizeObject } from '../security/redaction';
import type { PolicyCode, PolicyDecision } from '../domain/policy';

export const REJECTION_EXPLANATION_SCHEMA_VERSION = '1.0' as const;

export type RejectionCategory =
  | 'VALIDATION'
  | 'POLICY'
  | 'PERMISSION'
  | 'STALE_STATE'
  | 'SETTLEMENT'
  | 'RATE_LIMIT'
  | 'DEPENDENCY'
  | 'UNEXPECTED';

export type RejectionReasonCode =
  // Validation
  | 'VALIDATION_FAILED'
  | 'INVALID_PAYER_NAME'
  | 'INVALID_PAYER_EMAIL'
  | 'PAYER_INFO_TOO_LONG'
  | 'INVALID_STATUS'
  | 'INVALID_CURSOR'
  | 'INVALID_TX_HASH'
  | 'MISSING_TX_HASH'
  | 'INVALID_POLICY_PROPOSAL'
  | 'INVALID_TREND_EXPORT_REQUEST'
  | 'REFERENCE_MALFORMED_INPUT'
  // Policy
  | 'AMOUNT_TOO_LOW'
  | 'AMOUNT_TOO_HIGH'
  | 'ASSET_NOT_ALLOWED'
  | 'EXPIRY_OUT_OF_RANGE'
  | 'ALLOW_LIST_VIOLATION'
  | 'SIMULATION_DISABLED'
  // Permission
  | 'UNAUTHORIZED_SELLER'
  | 'SELLER_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'ADMIN_TOKEN_REQUIRED'
  | 'EXPORT_FORBIDDEN'
  | 'TREND_EXPORT_FORBIDDEN'
  | 'SENSITIVE_DIMENSION_FORBIDDEN'
  | 'CAPABILITY_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'CORS_ORIGIN_DENIED'
  | 'IMPERSONATION_REJECTED'
  // Stale-state / Lifecycle
  | 'STALE_STATE_CONFLICT'
  | 'CONFLICT'
  | 'INVOICE_EXPIRED'
  | 'INVOICE_ALREADY_PAID'
  | 'INVOICE_NOT_PENDING'
  | 'INVOICE_CANNOT_CANCEL'
  | 'INVOICE_NOT_FOUND'
  | 'EXPORT_EXPIRED'
  | 'CHECKPOINT_IN_PROGRESS'
  | 'CHECKPOINT_IN_DOUBT'
  | 'STALE_SOURCE_DATA'
  // Settlement
  | 'NO_PAYMENT_OPERATION'
  | 'MEMO_MISMATCH'
  | 'DESTINATION_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'ASSET_MISMATCH'
  | 'NETWORK_MISMATCH'
  // Rate limit / Backpressure
  | 'RATE_LIMITED'
  | 'QUEUE_BACKPRESSURE_ACTIVE'
  // Dependency
  | 'HORIZON_UNAVAILABLE'
  | 'TRANSACTION_NOT_FOUND'
  | 'EXTERNAL_SOURCE_TIMEOUT'
  | 'EXTERNAL_SOURCE_UNREACHABLE'
  // Unexpected fallback
  | 'UNEXPECTED_FAILURE';

export interface RecoveryHint {
  step: number;
  action: string;
  targetField?: string;
  automatedRetryEligible: boolean;
  retryDelayMs?: number;
}

export interface RejectionFieldError {
  field: string;
  code: string;
  message: string;
  hint: string;
}

export interface PolicyConstraintSummary {
  rule: PolicyCode | string;
  limit?: unknown;
  actual?: unknown;
  allowedValues?: unknown[];
}

export interface RejectionExplanation {
  schemaVersion: typeof REJECTION_EXPLANATION_SCHEMA_VERSION;
  reasonCode: RejectionReasonCode;
  category: RejectionCategory;
  httpStatus: number;
  title: string;
  summary: string;
  recoveryAction: string;
  recoveryHints: RecoveryHint[];
  retryable: boolean;
  userSafe: true;
  fieldErrors?: RejectionFieldError[];
  policyConstraint?: PolicyConstraintSummary;
  correlationId?: string;
  timestamp: string;
}

export interface RejectionCatalogEntry {
  reasonCode: RejectionReasonCode;
  category: RejectionCategory;
  httpStatus: number;
  title: string;
  summary: string;
  recoveryAction: string;
  recoveryHints: RecoveryHint[];
  retryable: boolean;
}

function hints(
  items: Array<{ action: string; targetField?: string; automatedRetryEligible?: boolean; retryDelayMs?: number }>
): RecoveryHint[] {
  return items.map((item, idx) => ({
    step: idx + 1,
    action: item.action,
    ...(item.targetField ? { targetField: item.targetField } : {}),
    automatedRetryEligible: Boolean(item.automatedRetryEligible),
    ...(item.retryDelayMs !== undefined ? { retryDelayMs: item.retryDelayMs } : {}),
  }));
}

export const REJECTION_REASON_CATALOG: Record<RejectionReasonCode, RejectionCatalogEntry> = {
  // --- Validation ---
  VALIDATION_FAILED: {
    reasonCode: 'VALIDATION_FAILED',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid request parameters',
    summary: 'One or more fields in the operation request failed validation.',
    recoveryAction: 'Review the highlighted fields, correct any invalid formats or ranges, and submit again.',
    recoveryHints: hints([
      { action: 'Inspect fieldErrors for the specific parameter that failed validation.' },
      { action: 'Ensure Stellar public keys start with G (56 chars) and amounts have at most 7 decimals.' },
    ]),
    retryable: false,
  },
  INVALID_PAYER_NAME: {
    reasonCode: 'INVALID_PAYER_NAME',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid payer name',
    summary: 'The provided payer name is not a valid text string.',
    recoveryAction: 'Enter a valid text string for the payer name or leave it empty.',
    recoveryHints: hints([
      { action: 'Provide a plain text payer name under 255 characters or omit the field.', targetField: 'payerName' },
    ]),
    retryable: false,
  },
  INVALID_PAYER_EMAIL: {
    reasonCode: 'INVALID_PAYER_EMAIL',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid payer email address',
    summary: 'The provided payer email address is malformed.',
    recoveryAction: 'Enter a valid email address (e.g. name@domain.com) or leave it empty.',
    recoveryHints: hints([
      { action: 'Format the email as local@domain.tld or clear the optional email input.', targetField: 'payerEmail' },
    ]),
    retryable: false,
  },
  PAYER_INFO_TOO_LONG: {
    reasonCode: 'PAYER_INFO_TOO_LONG',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Payer information exceeds maximum length',
    summary: 'Payer name or email exceeds the 255-character limit.',
    recoveryAction: 'Shorten payer name and email to under 255 characters.',
    recoveryHints: hints([
      { action: 'Trim payerName and payerEmail to 255 characters or fewer.', targetField: 'payerName' },
    ]),
    retryable: false,
  },
  INVALID_STATUS: {
    reasonCode: 'INVALID_STATUS',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid invoice status filter',
    summary: 'The requested status filter is not a recognized invoice lifecycle state.',
    recoveryAction: 'Filter by PENDING, PAID, EXPIRED, or CANCELLED, or omit status to list all invoices.',
    recoveryHints: hints([
      { action: 'Use one of: PENDING, PAID, EXPIRED, CANCELLED.', targetField: 'status' },
    ]),
    retryable: false,
  },
  INVALID_CURSOR: {
    reasonCode: 'INVALID_CURSOR',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Pagination cursor is invalid or expired',
    summary: 'The pagination cursor could not be decoded or does not match the current query scope.',
    recoveryAction: 'Drop the cursor parameter and restart pagination from the first page.',
    recoveryHints: hints([
      { action: 'Clear the cursor parameter and request the first page of results.', targetField: 'cursor' },
    ]),
    retryable: false,
  },
  INVALID_TX_HASH: {
    reasonCode: 'INVALID_TX_HASH',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid transaction hash format',
    summary: 'The transaction hash is not a valid 64-character hexadecimal Stellar transaction hash.',
    recoveryAction: 'Verify that the transaction hash contains exactly 64 hexadecimal characters.',
    recoveryHints: hints([
      { action: 'Copy the full 64-character hex transaction hash from your Stellar wallet or explorer.', targetField: 'txHash' },
    ]),
    retryable: false,
  },
  MISSING_TX_HASH: {
    reasonCode: 'MISSING_TX_HASH',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Transaction hash is required',
    summary: 'Payment verification requires a Stellar transaction hash, which was missing.',
    recoveryAction: 'Provide a 64-character transaction hash from your Stellar wallet after submitting payment.',
    recoveryHints: hints([
      { action: 'Submit the payment in your wallet first, then provide the resulting txHash.', targetField: 'txHash' },
    ]),
    retryable: false,
  },
  INVALID_POLICY_PROPOSAL: {
    reasonCode: 'INVALID_POLICY_PROPOSAL',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid policy configuration proposal',
    summary: 'The proposed policy parameters contain invalid types, unknown keys, or contradictory bounds.',
    recoveryAction: 'Ensure minAmount <= maxAmount, minExpiryDays <= defaultExpiryDays <= maxExpiryDays, and asset codes are valid.',
    recoveryHints: hints([
      { action: 'Check that all amounts are positive numbers with at most 7 decimal places.', targetField: 'proposedPolicy' },
      { action: 'Verify minAmount does not exceed maxAmount and expiry day bounds are consistent.', targetField: 'proposedPolicy' },
    ]),
    retryable: false,
  },
  INVALID_TREND_EXPORT_REQUEST: {
    reasonCode: 'INVALID_TREND_EXPORT_REQUEST',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Invalid trend export parameters',
    summary: 'The trend export request specified an invalid granularity, format, or date window.',
    recoveryAction: 'Specify a valid granularity (hour, day, week, month), format (json, csv), and ordered ISO date range.',
    recoveryHints: hints([
      { action: 'Ensure `from` is an ISO-8601 timestamp earlier than or equal to `to`.', targetField: 'from' },
      { action: 'Choose granularity from: hour, day, week, month.', targetField: 'granularity' },
    ]),
    retryable: false,
  },
  REFERENCE_MALFORMED_INPUT: {
    reasonCode: 'REFERENCE_MALFORMED_INPUT',
    category: 'VALIDATION',
    httpStatus: 400,
    title: 'Malformed external reference input',
    summary: 'The external reference identifier or type failed structural validation before verification.',
    recoveryAction: 'Provide a valid referenceId, referenceType, invoiceId, and properly formatted externalIdentifier.',
    recoveryHints: hints([
      { action: 'Verify the external reference ID and type match supported protocol schemas.', targetField: 'externalIdentifier' },
    ]),
    retryable: false,
  },

  // --- Policy ---
  AMOUNT_TOO_LOW: {
    reasonCode: 'AMOUNT_TOO_LOW',
    category: 'POLICY',
    httpStatus: 422,
    title: 'Invoice amount below policy minimum',
    summary: 'The requested invoice amount is smaller than the minimum allowed by platform policy.',
    recoveryAction: 'Increase the invoice amount to meet or exceed the policy minimum.',
    recoveryHints: hints([
      { action: 'Set the invoice amount to at least the minimum allowed amount in policyConstraint.limit.', targetField: 'amount' },
    ]),
    retryable: false,
  },
  AMOUNT_TOO_HIGH: {
    reasonCode: 'AMOUNT_TOO_HIGH',
    category: 'POLICY',
    httpStatus: 422,
    title: 'Invoice amount exceeds policy maximum',
    summary: 'The requested invoice amount exceeds the maximum single-invoice cap enforced by platform policy.',
    recoveryAction: 'Lower the invoice amount within the policy cap or split the billing across multiple invoices.',
    recoveryHints: hints([
      { action: 'Reduce the amount to at most policyConstraint.limit.', targetField: 'amount' },
      { action: 'Alternatively, split large settlements into milestone invoices within the cap.' },
    ]),
    retryable: false,
  },
  ASSET_NOT_ALLOWED: {
    reasonCode: 'ASSET_NOT_ALLOWED',
    category: 'POLICY',
    httpStatus: 422,
    title: 'Asset is not permitted by platform policy',
    summary: 'The selected asset code is not on the active policy allow-list.',
    recoveryAction: 'Select an approved Stellar asset from the policy allow-list.',
    recoveryHints: hints([
      { action: 'Switch assetCode to one of the permitted assets listed in policyConstraint.allowedValues.', targetField: 'assetCode' },
    ]),
    retryable: false,
  },
  EXPIRY_OUT_OF_RANGE: {
    reasonCode: 'EXPIRY_OUT_OF_RANGE',
    category: 'POLICY',
    httpStatus: 422,
    title: 'Invoice expiry window out of policy bounds',
    summary: 'The requested expiration window falls outside the allowed minimum and maximum days.',
    recoveryAction: 'Choose a whole number of expiry days within the permitted policy window.',
    recoveryHints: hints([
      { action: 'Set expiresInDays to an integer within the allowed [min, max] range.', targetField: 'expiresInDays' },
    ]),
    retryable: false,
  },
  ALLOW_LIST_VIOLATION: {
    reasonCode: 'ALLOW_LIST_VIOLATION',
    category: 'POLICY',
    httpStatus: 422,
    title: 'Destination or asset blocked by security allow-list',
    summary: 'The target issuer, destination, or origin is not permitted by the configured allow-list policy.',
    recoveryAction: 'Use a verified asset issuer or destination from the approved allow-list.',
    recoveryHints: hints([
      { action: 'Verify the asset issuer and seller public key against the platform allow-list.' },
    ]),
    retryable: false,
  },
  SIMULATION_DISABLED: {
    reasonCode: 'SIMULATION_DISABLED',
    category: 'POLICY',
    httpStatus: 403,
    title: 'Payment simulation is disabled in this environment',
    summary: 'Simulated payments are restricted by runtime policy in production environments.',
    recoveryAction: 'Use real Stellar Testnet or Public network transactions, or enable simulation in local dev.',
    recoveryHints: hints([
      { action: 'Submit an actual Stellar transaction and verify via /api/invoices/:id/verify.' },
    ]),
    retryable: false,
  },

  // --- Permission ---
  UNAUTHORIZED_SELLER: {
    reasonCode: 'UNAUTHORIZED_SELLER',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Not authorized for this seller wallet',
    summary: 'The connected wallet does not own or have permission to modify this invoice.',
    recoveryAction: 'Switch to the Stellar wallet that created the invoice and try again.',
    recoveryHints: hints([
      { action: 'Open Freighter and switch to the seller public key associated with this invoice.', targetField: 'sellerPublicKey' },
    ]),
    retryable: false,
  },
  SELLER_REQUIRED: {
    reasonCode: 'SELLER_REQUIRED',
    category: 'PERMISSION',
    httpStatus: 400,
    title: 'Seller wallet public key is required',
    summary: 'This operation requires a seller wallet public key to scope authorization.',
    recoveryAction: 'Connect your Freighter wallet or supply the sellerPublicKey parameter.',
    recoveryHints: hints([
      { action: 'Connect your Stellar wallet so sellerPublicKey is included in the request.', targetField: 'sellerPublicKey' },
    ]),
    retryable: false,
  },
  PERMISSION_DENIED: {
    reasonCode: 'PERMISSION_DENIED',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Permission denied',
    summary: 'Your current actor role does not have sufficient privileges to perform this operation.',
    recoveryAction: 'Authenticate with an account or maintainer token that holds the required role.',
    recoveryHints: hints([
      { action: 'Verify your authentication credentials and role permissions.' },
      { action: 'If this is an operational endpoint, provide a valid maintainer bearer token.' },
    ]),
    retryable: false,
  },
  ADMIN_TOKEN_REQUIRED: {
    reasonCode: 'ADMIN_TOKEN_REQUIRED',
    category: 'PERMISSION',
    httpStatus: 401,
    title: 'Maintainer authentication required',
    summary: 'This operational endpoint requires a valid maintainer bearer token.',
    recoveryAction: 'Supply the Authorization: Bearer <JOBS_ADMIN_TOKEN> header.',
    recoveryHints: hints([
      { action: 'Include a valid Authorization: Bearer token matching JOBS_ADMIN_TOKEN.' },
    ]),
    retryable: false,
  },
  EXPORT_FORBIDDEN: {
    reasonCode: 'EXPORT_FORBIDDEN',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Cross-wallet export is forbidden',
    summary: 'You can only export invoice data belonging to your own authenticated seller wallet.',
    recoveryAction: 'Set sellerPublicKey to match the requesting wallet address.',
    recoveryHints: hints([
      { action: 'Ensure requester and sellerPublicKey match your connected wallet.', targetField: 'sellerPublicKey' },
    ]),
    retryable: false,
  },
  TREND_EXPORT_FORBIDDEN: {
    reasonCode: 'TREND_EXPORT_FORBIDDEN',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Maintainer role required for trend export',
    summary: 'Platform-wide operational and financial trend exports are restricted to maintainers.',
    recoveryAction: 'Authenticate with a maintainer account and valid admin credentials.',
    recoveryHints: hints([
      { action: 'Use a maintainer actor role and supply the admin bearer token.' },
    ]),
    retryable: false,
  },
  SENSITIVE_DIMENSION_FORBIDDEN: {
    reasonCode: 'SENSITIVE_DIMENSION_FORBIDDEN',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Sensitive or private dimension cannot be exported',
    summary: 'The export requested one or more private/PII dimensions that are protected from disclosure.',
    recoveryAction: 'Remove sensitive dimensions (emails, names, raw keys, memos, IP) and use approved dimensions.',
    recoveryHints: hints([
      {
        action: 'Restrict dimensions to allowed values: asset, status, operation, errorCode, actorType, jobType, sellerCohort.',
        targetField: 'dimensions',
      },
    ]),
    retryable: false,
  },
  CAPABILITY_REQUIRED: {
    reasonCode: 'CAPABILITY_REQUIRED',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Scoped capability token required',
    summary: 'This high-sensitivity action requires a valid, unrevoked single-use capability token.',
    recoveryAction: 'Issue a fresh capability token via POST /api/ops/capabilities for this action and target.',
    recoveryHints: hints([
      { action: 'Request a capability token for the exact action and target via POST /api/ops/capabilities.' },
      { action: 'Pass the token in the X-Capability-Token header before it expires.' },
    ]),
    retryable: false,
  },
  APPROVAL_REQUIRED: {
    reasonCode: 'APPROVAL_REQUIRED',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Two-person maintainer approval required',
    summary: 'This high-impact action cannot execute until a second maintainer approves the intent.',
    recoveryAction: 'Create an intent via POST /api/ops/intents, obtain peer approval, and then execute.',
    recoveryHints: hints([
      { action: 'Submit an action intent with POST /api/ops/intents.' },
      { action: 'Have a second maintainer approve the intent before calling execute.' },
    ]),
    retryable: false,
  },
  CORS_ORIGIN_DENIED: {
    reasonCode: 'CORS_ORIGIN_DENIED',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Request origin is not permitted',
    summary: 'The browser origin is not in the configured CORS allow-list.',
    recoveryAction: 'Access the application from an approved frontend origin or update FRONTEND_URL.',
    recoveryHints: hints([
      { action: 'Use the official application URL or add your origin to FRONTEND_URL.' },
    ]),
    retryable: false,
  },
  IMPERSONATION_REJECTED: {
    reasonCode: 'IMPERSONATION_REJECTED',
    category: 'PERMISSION',
    httpStatus: 403,
    title: 'Maintainer impersonation session rejected',
    summary: 'The impersonation request failed validation or requested disallowed permissions.',
    recoveryAction: 'Provide a valid maintainerId, audit reason, Stellar targetId, and permitted scope.',
    recoveryHints: hints([
      { action: 'Supply a non-empty audit reason and valid Stellar G-address as targetId.' },
    ]),
    retryable: false,
  },

  // --- Stale-State / Lifecycle ---
  STALE_STATE_CONFLICT: {
    reasonCode: 'STALE_STATE_CONFLICT',
    category: 'STALE_STATE',
    httpStatus: 409,
    title: 'Record state changed since last read',
    summary: 'The target record was modified by another concurrent operation, invalidating your cached version.',
    recoveryAction: 'Re-fetch the latest record state, verify the updated status and version, and retry if still applicable.',
    recoveryHints: hints([
      { action: 'Fetch the latest record from the server to obtain the current version and status.', automatedRetryEligible: true, retryDelayMs: 250 },
      { action: 'Re-apply your operation using the updated expectedVersion token.' },
    ]),
    retryable: true,
  },
  CONFLICT: {
    reasonCode: 'CONFLICT',
    category: 'STALE_STATE',
    httpStatus: 409,
    title: 'Concurrent modification conflict',
    summary: 'The invoice was modified by another session before your request completed.',
    recoveryAction: 'Refresh the invoice to get the latest version, then retry the operation.',
    recoveryHints: hints([
      { action: 'Reload the invoice details to sync the latest version.', automatedRetryEligible: true, retryDelayMs: 250 },
      { action: 'Retry the action if the invoice is still in the expected state.' },
    ]),
    retryable: true,
  },
  INVOICE_EXPIRED: {
    reasonCode: 'INVOICE_EXPIRED',
    category: 'STALE_STATE',
    httpStatus: 400,
    title: 'Invoice payment window has expired',
    summary: 'This invoice passed its expiration timestamp and can no longer accept payment or modifications.',
    recoveryAction: 'Contact the seller to issue a new invoice with a fresh expiration window.',
    recoveryHints: hints([
      { action: 'Do not submit payment to an expired invoice.' },
      { action: 'Request a replacement invoice from the seller.' },
    ]),
    retryable: false,
  },
  INVOICE_ALREADY_PAID: {
    reasonCode: 'INVOICE_ALREADY_PAID',
    category: 'STALE_STATE',
    httpStatus: 400,
    title: 'Invoice is already settled',
    summary: 'A verified payment has already been recorded for this invoice.',
    recoveryAction: 'No further payment is needed. Download or view your payment receipt.',
    recoveryHints: hints([
      { action: 'Refresh the page to view the settled receipt and transaction hash.' },
    ]),
    retryable: false,
  },
  INVOICE_NOT_PENDING: {
    reasonCode: 'INVOICE_NOT_PENDING',
    category: 'STALE_STATE',
    httpStatus: 400,
    title: 'Invoice is no longer pending',
    summary: 'The operation requires the invoice to be in PENDING status, but it has already transitioned.',
    recoveryAction: 'Refresh the invoice status on the dashboard before taking further action.',
    recoveryHints: hints([
      { action: 'Reload the invoice to see whether it was paid, cancelled, or expired.' },
    ]),
    retryable: false,
  },
  INVOICE_CANNOT_CANCEL: {
    reasonCode: 'INVOICE_CANNOT_CANCEL',
    category: 'STALE_STATE',
    httpStatus: 400,
    title: 'Invoice cannot be cancelled in its current state',
    summary: 'Only PENDING invoices can be cancelled; settled or expired invoices are immutable.',
    recoveryAction: 'Refresh the dashboard to view the current terminal status of the invoice.',
    recoveryHints: hints([
      { action: 'Verify the invoice status; if it was already paid, issue a refund separately if needed.' },
    ]),
    retryable: false,
  },
  INVOICE_NOT_FOUND: {
    reasonCode: 'INVOICE_NOT_FOUND',
    category: 'STALE_STATE',
    httpStatus: 404,
    title: 'Invoice not found',
    summary: 'No invoice exists with the requested identifier, or it was removed by retention policy.',
    recoveryAction: 'Check the invoice ID in the URL and verify you are connected to the right environment.',
    recoveryHints: hints([
      { action: 'Verify the invoice UUID in the link or return to the dashboard list.' },
    ]),
    retryable: false,
  },
  EXPORT_EXPIRED: {
    reasonCode: 'EXPORT_EXPIRED',
    category: 'STALE_STATE',
    httpStatus: 410,
    title: 'Export artifact has expired',
    summary: 'The generated export exceeded its retention window and was automatically purged.',
    recoveryAction: 'Generate a new export via POST /api/exports and download it before expiry.',
    recoveryHints: hints([
      { action: 'Trigger a fresh export request and download the new artifact ID.' },
    ]),
    retryable: false,
  },
  CHECKPOINT_IN_PROGRESS: {
    reasonCode: 'CHECKPOINT_IN_PROGRESS',
    category: 'STALE_STATE',
    httpStatus: 409,
    title: 'Operation is already in progress',
    summary: 'An identical idempotent operation is currently executing in another worker or request.',
    recoveryAction: 'Wait briefly for the in-flight operation to finish, then poll or retry with the same idempotency key.',
    recoveryHints: hints([
      { action: 'Wait 1-2 seconds and retry with the same idempotencyKey to read the completed result.', automatedRetryEligible: true, retryDelayMs: 1500 },
    ]),
    retryable: true,
  },
  CHECKPOINT_IN_DOUBT: {
    reasonCode: 'CHECKPOINT_IN_DOUBT',
    category: 'STALE_STATE',
    httpStatus: 409,
    title: 'Previous operation interrupted mid-flight',
    summary: 'A prior execution with this idempotency key crashed before recording completion and requires reconciliation.',
    recoveryAction: 'Inspect the recovery checkpoint in the ops dashboard before forcing a retry.',
    recoveryHints: hints([
      { action: 'Check whether the external side effect succeeded before clearing or retrying the checkpoint.' },
    ]),
    retryable: false,
  },
  STALE_SOURCE_DATA: {
    reasonCode: 'STALE_SOURCE_DATA',
    category: 'STALE_STATE',
    httpStatus: 422,
    title: 'External reference data is stale',
    summary: 'The external source returned data whose timestamp is outside the acceptable freshness window.',
    recoveryAction: 'Obtain a fresh attestation or updated transaction record from the external source.',
    recoveryHints: hints([
      { action: 'Request a newly signed or updated reference from the upstream provider.' },
    ]),
    retryable: false,
  },

  // --- Settlement ---
  NO_PAYMENT_OPERATION: {
    reasonCode: 'NO_PAYMENT_OPERATION',
    category: 'SETTLEMENT',
    httpStatus: 400,
    title: 'No payment operation found in transaction',
    summary: 'The Stellar transaction did not contain a payment or path-payment operation.',
    recoveryAction: 'Submit a standard Stellar payment operation targeting the seller address.',
    recoveryHints: hints([
      { action: 'Ensure the transaction includes a `payment` or `path_payment` operation.' },
    ]),
    retryable: false,
  },
  MEMO_MISMATCH: {
    reasonCode: 'MEMO_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    title: 'Transaction memo does not match invoice',
    summary: 'The memo attached to the Stellar transaction did not match the required invoice memo.',
    recoveryAction: 'Include the exact invoice memo in your transaction memo field.',
    recoveryHints: hints([
      { action: 'Copy the exact memo string shown on the invoice payment page.', targetField: 'memo' },
    ]),
    retryable: false,
  },
  DESTINATION_MISMATCH: {
    reasonCode: 'DESTINATION_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    title: 'Payment sent to wrong destination address',
    summary: 'The recipient address in the Stellar transaction does not match the invoice seller public key.',
    recoveryAction: 'Send payment directly to the seller public key specified on the invoice.',
    recoveryHints: hints([
      { action: 'Verify the recipient G-address matches the invoice sellerPublicKey.' },
    ]),
    retryable: false,
  },
  AMOUNT_MISMATCH: {
    reasonCode: 'AMOUNT_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    title: 'Payment amount does not match invoice',
    summary: 'The amount transferred in the transaction differs from the required invoice amount.',
    recoveryAction: 'Send the exact invoice amount at 7-decimal stroop precision.',
    recoveryHints: hints([
      { action: 'Ensure the payment amount matches the invoice total without fee deductions.' },
    ]),
    retryable: false,
  },
  ASSET_MISMATCH: {
    reasonCode: 'ASSET_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    title: 'Payment asset does not match invoice',
    summary: 'The asset code or issuer in the transaction does not match the invoice asset.',
    recoveryAction: 'Pay using the exact asset code and issuer specified on the invoice.',
    recoveryHints: hints([
      { action: 'Verify both the asset code (e.g. XLM, USDC) and the asset issuer address.' },
    ]),
    retryable: false,
  },
  NETWORK_MISMATCH: {
    reasonCode: 'NETWORK_MISMATCH',
    category: 'SETTLEMENT',
    httpStatus: 400,
    title: 'Stellar network mismatch',
    summary: 'The wallet or transaction is on a different Stellar network than the invoice requires.',
    recoveryAction: 'Switch your Freighter wallet to the matching Stellar network (Testnet or Public).',
    recoveryHints: hints([
      { action: 'Open Freighter settings and switch network to match the invoice network banner.' },
    ]),
    retryable: false,
  },

  // --- Rate Limit / Backpressure ---
  RATE_LIMITED: {
    reasonCode: 'RATE_LIMITED',
    category: 'RATE_LIMIT',
    httpStatus: 429,
    title: 'Rate limit exceeded',
    summary: 'Too many requests were sent in a short window.',
    recoveryAction: 'Wait a few seconds before retrying the operation.',
    recoveryHints: hints([
      { action: 'Back off for the suggested retry delay before sending another request.', automatedRetryEligible: true, retryDelayMs: 3000 },
    ]),
    retryable: true,
  },
  QUEUE_BACKPRESSURE_ACTIVE: {
    reasonCode: 'QUEUE_BACKPRESSURE_ACTIVE',
    category: 'RATE_LIMIT',
    httpStatus: 429,
    title: 'Background queue is temporarily saturated',
    summary: 'The background job queue is shedding non-critical work to preserve system stability.',
    recoveryAction: 'Wait for the Retry-After window to elapse and resubmit the background job.',
    recoveryHints: hints([
      { action: 'Retry after the Retry-After delay when queue depth drains below watermark.', automatedRetryEligible: true, retryDelayMs: 2000 },
    ]),
    retryable: true,
  },

  // --- Dependency ---
  HORIZON_UNAVAILABLE: {
    reasonCode: 'HORIZON_UNAVAILABLE',
    category: 'DEPENDENCY',
    httpStatus: 503,
    title: 'Stellar Horizon is temporarily unreachable',
    summary: 'The upstream Stellar Horizon API timed out or returned a transient network error.',
    recoveryAction: 'Wait a few seconds and retry verification; your on-chain payment is safe.',
    recoveryHints: hints([
      { action: 'Retry verification in a few seconds once Horizon connectivity recovers.', automatedRetryEligible: true, retryDelayMs: 3000 },
    ]),
    retryable: true,
  },
  TRANSACTION_NOT_FOUND: {
    reasonCode: 'TRANSACTION_NOT_FOUND',
    category: 'DEPENDENCY',
    httpStatus: 404,
    title: 'Transaction not yet indexed on Horizon',
    summary: 'The transaction hash was not found on Stellar Horizon yet (ledger close takes ~5 seconds).',
    recoveryAction: 'Wait ~5 seconds for the Stellar ledger to close and retry verification.',
    recoveryHints: hints([
      { action: 'Wait 5 seconds for ledger propagation and retry.', automatedRetryEligible: true, retryDelayMs: 5000 },
      { action: 'Confirm your wallet submitted the transaction on the matching Stellar network.' },
    ]),
    retryable: true,
  },
  EXTERNAL_SOURCE_TIMEOUT: {
    reasonCode: 'EXTERNAL_SOURCE_TIMEOUT',
    category: 'DEPENDENCY',
    httpStatus: 504,
    title: 'External reference verification timed out',
    summary: 'The upstream verification source did not respond before the deadline elapsed.',
    recoveryAction: 'Allow automatic retry with exponential backoff or re-trigger verification shortly.',
    recoveryHints: hints([
      { action: 'Retry verification with exponential backoff.', automatedRetryEligible: true, retryDelayMs: 2000 },
    ]),
    retryable: true,
  },
  EXTERNAL_SOURCE_UNREACHABLE: {
    reasonCode: 'EXTERNAL_SOURCE_UNREACHABLE',
    category: 'DEPENDENCY',
    httpStatus: 503,
    title: 'External reference source is unreachable',
    summary: 'The upstream verification endpoint returned a transient error or connection failure.',
    recoveryAction: 'Retry once the upstream service recovers or inspect dependency health at /api/ops/dependencies.',
    recoveryHints: hints([
      { action: 'Retry after backoff or check /api/ops/dependencies for upstream outage status.', automatedRetryEligible: true, retryDelayMs: 3000 },
    ]),
    retryable: true,
  },

  // --- Unexpected Failure Fallback ---
  UNEXPECTED_FAILURE: {
    reasonCode: 'UNEXPECTED_FAILURE',
    category: 'UNEXPECTED',
    httpStatus: 500,
    title: 'Operation could not be completed',
    summary: 'An unexpected internal error prevented the operation from completing safely.',
    recoveryAction: 'Retry your request. If the issue persists, share the correlationId with support.',
    recoveryHints: hints([
      { action: 'Retry the operation once in case of a transient fault.', automatedRetryEligible: true, retryDelayMs: 2000 },
      { action: 'Record the correlationId from this response if contacting support.' },
    ]),
    retryable: true,
  },
};

export interface ExplainRejectionOptions {
  correlationId?: string;
  now?: Date;
}

function buildFieldHint(field: string, message: string): string {
  const lower = field.toLowerCase();
  if (lower.includes('sellerpublickey') || lower.includes('publickey') || lower.includes('requester')) {
    return 'Provide a valid 56-character Stellar public key starting with G.';
  }
  if (lower.includes('amount')) {
    return 'Provide a positive number with at most 7 decimal places (stroop precision).';
  }
  if (lower.includes('email')) {
    return 'Enter a valid email address (e.g. user@example.com) or omit if optional.';
  }
  if (lower.includes('assetcode') || lower.includes('asset')) {
    return 'Use a 1-12 character alphanumeric Stellar asset code (e.g. XLM, USDC).';
  }
  if (lower.includes('memo')) {
    return 'Provide a memo up to 28 bytes without control characters.';
  }
  if (lower.includes('expires') || lower.includes('days')) {
    return 'Provide a whole number of days within the allowed policy expiry window.';
  }
  if (lower.includes('txhash') || lower.includes('hash')) {
    return 'Provide a 64-character hexadecimal transaction hash.';
  }
  return `Correct the value for '${field}' (${redactErrorMessage(message)}) and try again.`;
}

function isPolicyDecisionDenial(input: unknown): input is Extract<PolicyDecision, { allowed: false }> {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as any).allowed === false &&
    typeof (input as any).code === 'string' &&
    typeof (input as any).message === 'string'
  );
}

/**
 * Normalizes any thrown error, Zod issue list, PolicyDecision denial, or domain rejection
 * into a user-safe `RejectionExplanation` with stable reasonCode and recoveryHints.
 */
export function explainRejection(
  input: unknown,
  options: ExplainRejectionOptions = {}
): RejectionExplanation {
  const nowIso = (options.now ?? new Date()).toISOString();
  const correlationId = options.correlationId || (input as any)?.correlationId;

  // 1. Direct PolicyDecision object ({ allowed: false, code, message, details })
  if (isPolicyDecisionDenial(input)) {
    const code = (input.code in REJECTION_REASON_CATALOG ? input.code : 'ALLOW_LIST_VIOLATION') as RejectionReasonCode;
    const base = REJECTION_REASON_CATALOG[code];
    const details = input.details ?? {};
    const limit = details.min ?? details.max ?? details.allowed;
    return {
      schemaVersion: REJECTION_EXPLANATION_SCHEMA_VERSION,
      reasonCode: base.reasonCode,
      category: 'POLICY',
      httpStatus: base.httpStatus,
      title: base.title,
      summary: redactErrorMessage(input.message || base.summary),
      recoveryAction: base.recoveryAction,
      recoveryHints: base.recoveryHints.map((h) => ({ ...h })),
      retryable: false,
      userSafe: true,
      policyConstraint: {
        rule: input.code,
        ...(limit !== undefined ? { limit } : {}),
        ...(Array.isArray(details.allowed) ? { allowedValues: details.allowed } : {}),
      },
      ...(correlationId ? { correlationId } : {}),
      timestamp: nowIso,
    };
  }

  const errObj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, any>;

  // 2. Zod validation errors (issues array of objects with path/message)
  if (
    errObj.name === 'ZodError' ||
    (Array.isArray(errObj.issues) &&
      errObj.issues.length > 0 &&
      typeof errObj.issues[0] === 'object' &&
      errObj.issues[0] !== null)
  ) {
    const issues: Array<{ path?: Array<string | number>; code?: string; message?: string }> = errObj.issues ?? [];
    const fieldErrors: RejectionFieldError[] = issues.slice(0, 25).map((issue) => {
      const field = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : 'input';
      const msg = redactErrorMessage(String(issue.message || 'Invalid value'));
      return {
        field,
        code: String(issue.code || 'INVALID_FIELD').toUpperCase(),
        message: msg,
        hint: buildFieldHint(field, msg),
      };
    });

    const base = REJECTION_REASON_CATALOG.VALIDATION_FAILED;
    const firstField = fieldErrors[0];
    const summary = firstField
      ? `Validation failed on '${firstField.field}': ${firstField.message}`
      : base.summary;

    const dynamicHints: RecoveryHint[] =
      fieldErrors.length > 0
        ? fieldErrors.map((fe, idx) => ({
            step: idx + 1,
            action: fe.hint,
            targetField: fe.field,
            automatedRetryEligible: false,
          }))
        : base.recoveryHints.map((h) => ({ ...h }));

    return {
      schemaVersion: REJECTION_EXPLANATION_SCHEMA_VERSION,
      reasonCode: 'VALIDATION_FAILED',
      category: 'VALIDATION',
      httpStatus: 400,
      title: base.title,
      summary,
      recoveryAction: firstField ? firstField.hint : base.recoveryAction,
      recoveryHints: dynamicHints,
      retryable: false,
      userSafe: true,
      fieldErrors,
      ...(correlationId ? { correlationId } : {}),
      timestamp: nowIso,
    };
  }

  // 3. Explicit reasonCode / code mapping
  const rawCode = String(errObj.reasonCode || errObj.code || '').trim();
  const mappedCode = resolveReasonCode(rawCode, errObj);
  const catalogEntry = REJECTION_REASON_CATALOG[mappedCode];

  // For unexpected failures, never leak raw database/internal error messages
  const isUnexpected = mappedCode === 'UNEXPECTED_FAILURE';
  const rawMsg = typeof errObj.message === 'string' ? errObj.message.trim() : '';
  const looksLikeInternalLeak =
    /select\s+|insert\s+|update\s+|delete\s+|pg_catalog|syntax error|econnrefused|stack|at\s+\w+\s*\(|\/home\/|\/usr\//i.test(
      rawMsg
    );

  const safeSummary =
    !isUnexpected && rawMsg.length > 0 && !rawMsg.includes('\n') && !looksLikeInternalLeak
      ? redactErrorMessage(rawMsg)
      : catalogEntry.summary;

  const explanation: RejectionExplanation = {
    schemaVersion: REJECTION_EXPLANATION_SCHEMA_VERSION,
    reasonCode: catalogEntry.reasonCode,
    category: catalogEntry.category,
    httpStatus:
      typeof errObj.httpStatus === 'number' && errObj.httpStatus >= 400 && errObj.httpStatus < 600
        ? errObj.httpStatus
        : catalogEntry.httpStatus,
    title: catalogEntry.title,
    summary: safeSummary,
    recoveryAction: catalogEntry.recoveryAction,
    recoveryHints: catalogEntry.recoveryHints.map((h) => ({ ...h })),
    retryable: typeof errObj.retryable === 'boolean' ? errObj.retryable : catalogEntry.retryable,
    userSafe: true,
    ...(correlationId ? { correlationId } : {}),
    timestamp: nowIso,
  };

  if (catalogEntry.category === 'POLICY') {
    explanation.policyConstraint = {
      rule: catalogEntry.reasonCode,
      ...(errObj.details ? sanitizeObject(errObj.details) : {}),
    };
  }

  return explanation;
}

function resolveReasonCode(rawCode: string, errObj: Record<string, any>): RejectionReasonCode {
  const name = String(errObj.name || '');
  const msg = String(errObj.message || '');

  if (name === 'ConflictError' || rawCode === 'OPTIMISTIC_LOCK_CONFLICT') {
    return 'STALE_STATE_CONFLICT';
  }

  if (rawCode && rawCode in REJECTION_REASON_CATALOG) {
    return rawCode as RejectionReasonCode;
  }
  if (name === 'CheckpointInProgressError') {
    return 'CHECKPOINT_IN_PROGRESS';
  }
  if (name === 'CheckpointInDoubtError' || name === 'CheckpointKeyReusedError') {
    return 'CHECKPOINT_IN_DOUBT';
  }
  if (name === 'ExportForbiddenError') {
    return 'EXPORT_FORBIDDEN';
  }
  if (name === 'TrendExportPermissionError' || name === 'PolicySimulationPermissionError') {
    if (rawCode === 'SENSITIVE_DIMENSION_FORBIDDEN') return 'SENSITIVE_DIMENSION_FORBIDDEN';
    if (rawCode === 'TREND_EXPORT_FORBIDDEN') return 'TREND_EXPORT_FORBIDDEN';
    return 'PERMISSION_DENIED';
  }
  if (name === 'TrendExportValidationError') {
    return 'INVALID_TREND_EXPORT_REQUEST';
  }
  if (name === 'PolicyDryRunError' || name === 'PolicySimulationValidationError') {
    return rawCode === 'INVALID_CURSOR' ? 'INVALID_CURSOR' : 'INVALID_POLICY_PROPOSAL';
  }
  if (name === 'CapabilityError' || rawCode.startsWith('CAPABILITY_')) {
    return 'CAPABILITY_REQUIRED';
  }
  if (name === 'ApprovalError' || rawCode.startsWith('INTENT_') || rawCode === 'APPROVALS_DISABLED') {
    return 'APPROVAL_REQUIRED';
  }
  if (name === 'AllowListError' || rawCode.startsWith('ALLOW_LIST')) {
    return 'ALLOW_LIST_VIOLATION';
  }
  if (name === 'QueueBackpressureError') {
    return 'QUEUE_BACKPRESSURE_ACTIVE';
  }
  if (rawCode === 'SOURCE_TIMEOUT') {
    return 'EXTERNAL_SOURCE_TIMEOUT';
  }
  if (rawCode === 'SOURCE_UNREACHABLE' || rawCode === 'RETRY_EXHAUSTED') {
    return 'EXTERNAL_SOURCE_UNREACHABLE';
  }
  if (rawCode === 'UNAUTHORIZED' || rawCode === 'ADMIN_DISABLED' || errObj.httpStatus === 401) {
    return 'ADMIN_TOKEN_REQUIRED';
  }
  if (rawCode === 'FORBIDDEN' || errObj.httpStatus === 403) {
    return 'PERMISSION_DENIED';
  }
  if (rawCode === 'INTERNAL_ERROR') {
    return 'UNEXPECTED_FAILURE';
  }

  // Message-based heuristics for legacy errors without explicit codes
  if (/version mismatch|modified by another|optimistic lock|stale state/i.test(msg)) {
    return 'STALE_STATE_CONFLICT';
  }
  if (/not authorized|permission denied|forbidden|maintainer role required/i.test(msg)) {
    return 'PERMISSION_DENIED';
  }
  if (/sellerPublicKey|Seller public key/i.test(msg)) {
    return 'SELLER_REQUIRED';
  }
  if (/already paid/i.test(msg)) {
    return 'INVOICE_ALREADY_PAID';
  }
  if (/cannot be cancelled|already processed/i.test(msg)) {
    return 'INVOICE_CANNOT_CANCEL';
  }
  if (/invoice.*expired|payment window.*elapsed/i.test(msg)) {
    return 'INVOICE_EXPIRED';
  }
  if (/invoice not found/i.test(msg)) {
    return 'INVOICE_NOT_FOUND';
  }
  if (/horizon|network/i.test(msg) || rawCode === 'ECONNREFUSED' || rawCode === 'ETIMEDOUT') {
    return 'HORIZON_UNAVAILABLE';
  }

  return 'UNEXPECTED_FAILURE';
}

/**
 * Builds a complete, client-ready rejected operation response envelope.
 */
export function buildRejectedOperationEnvelope(
  input: unknown,
  options: ExplainRejectionOptions = {}
): {
  success: false;
  error: string;
  code: RejectionReasonCode;
  category: RejectionCategory;
  retryable: boolean;
  recoveryAction: string;
  explanation: RejectionExplanation;
  correlationId?: string;
  timestamp: string;
} {
  const explanation = explainRejection(input, options);
  return {
    success: false,
    error: explanation.summary,
    code: explanation.reasonCode,
    category: explanation.category,
    retryable: explanation.retryable,
    recoveryAction: explanation.recoveryAction,
    explanation,
    ...(explanation.correlationId ? { correlationId: explanation.correlationId } : {}),
    timestamp: explanation.timestamp,
  };
}
