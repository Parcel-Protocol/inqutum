'use strict';

/**
 * Client-side Rejection Explanation Resolver & Formatter.
 *
 * Ensures consistent rendering of rejected operations across frontend pages
 * and components whether the rejection arrives as a structured backend
 * `explanation` envelope, an Axios/fetch error response, or a client-side
 * validation/policy/permission/stale-state error.
 */

const CLIENT_REJECTION_CATALOG = Object.freeze({
  VALIDATION_FAILED: {
    category: 'VALIDATION',
    title: 'Invalid request parameters',
    summary: 'One or more fields in the operation request failed validation.',
    recoveryAction: 'Review the highlighted fields, correct any invalid formats, and submit again.',
    retryable: false,
  },
  AMOUNT_TOO_LOW: {
    category: 'POLICY',
    title: 'Invoice amount below policy minimum',
    summary: 'The requested invoice amount is smaller than the minimum allowed by platform policy.',
    recoveryAction: 'Increase the invoice amount to meet or exceed the policy minimum.',
    retryable: false,
  },
  AMOUNT_TOO_HIGH: {
    category: 'POLICY',
    title: 'Invoice amount exceeds policy maximum',
    summary: 'The requested invoice amount exceeds the maximum single-invoice cap.',
    recoveryAction: 'Lower the invoice amount within the policy cap or split across multiple invoices.',
    retryable: false,
  },
  ASSET_NOT_ALLOWED: {
    category: 'POLICY',
    title: 'Asset is not permitted by platform policy',
    summary: 'The selected asset code is not on the active policy allow-list.',
    recoveryAction: 'Select an approved Stellar asset from the policy allow-list.',
    retryable: false,
  },
  EXPIRY_OUT_OF_RANGE: {
    category: 'POLICY',
    title: 'Invoice expiry window out of policy bounds',
    summary: 'The requested expiration window falls outside the allowed minimum and maximum days.',
    recoveryAction: 'Choose a whole number of expiry days within the permitted policy window.',
    retryable: false,
  },
  UNAUTHORIZED_SELLER: {
    category: 'PERMISSION',
    title: 'Not authorized for this seller wallet',
    summary: 'The connected wallet does not own or have permission to modify this invoice.',
    recoveryAction: 'Switch to the Stellar wallet that created the invoice and try again.',
    retryable: false,
  },
  PERMISSION_DENIED: {
    category: 'PERMISSION',
    title: 'Permission denied',
    summary: 'Your current wallet or role does not have permission to perform this operation.',
    recoveryAction: 'Verify your connected wallet or maintainer credentials and try again.',
    retryable: false,
  },
  STALE_STATE_CONFLICT: {
    category: 'STALE_STATE',
    title: 'Record state changed since last read',
    summary: 'The target record was modified by another session, invalidating your cached state.',
    recoveryAction: 'Refresh the page to load the latest state and retry if still applicable.',
    retryable: true,
  },
  CONFLICT: {
    category: 'STALE_STATE',
    title: 'Concurrent modification conflict',
    summary: 'The invoice was modified by another session before your request completed.',
    recoveryAction: 'Refresh the invoice to get the latest version, then retry the operation.',
    retryable: true,
  },
  INVOICE_EXPIRED: {
    category: 'STALE_STATE',
    title: 'Invoice payment window has expired',
    summary: 'This invoice passed its expiration timestamp and can no longer accept payment.',
    recoveryAction: 'Contact the seller to issue a new invoice.',
    retryable: false,
  },
  INVOICE_ALREADY_PAID: {
    category: 'STALE_STATE',
    title: 'Invoice is already settled',
    summary: 'A verified payment has already been recorded for this invoice.',
    recoveryAction: 'No further payment is needed. View or download your payment receipt.',
    retryable: false,
  },
  UNEXPECTED_FAILURE: {
    category: 'UNEXPECTED',
    title: 'Operation could not be completed',
    summary: 'An unexpected error prevented the operation from completing safely.',
    recoveryAction: 'Retry your request. If the issue persists, share the correlation ID with support.',
    retryable: true,
  },
});

function sanitizeClientText(raw, fallback) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const trimmed = raw.trim();
  if (/select\s+|insert\s+|pg_catalog|syntax error|at\s+\w+\s*\(/i.test(trimmed)) {
    return fallback;
  }
  return trimmed.replace(/S[A-Z2-7]{55}/g, '[REDACTED_SECRET]');
}

function resolveRejectionExplanation(errorOrPayload) {
  const payload = errorOrPayload?.response?.data || errorOrPayload || {};
  const embedded = payload?.explanation;

  if (embedded && typeof embedded === 'object' && typeof embedded.reasonCode === 'string') {
    return {
      schemaVersion: '1.0',
      reasonCode: embedded.reasonCode,
      category: embedded.category || 'UNEXPECTED',
      title: sanitizeClientText(embedded.title, 'Operation rejected'),
      summary: sanitizeClientText(embedded.summary, 'The operation could not be completed.'),
      recoveryAction: sanitizeClientText(
        embedded.recoveryAction,
        'Review your input or refresh the page and try again.'
      ),
      recoveryHints: Array.isArray(embedded.recoveryHints)
        ? embedded.recoveryHints.map((h, i) => ({
            step: Number(h.step) || i + 1,
            action: sanitizeClientText(h.action, 'Follow recovery guidance.'),
            ...(h.targetField ? { targetField: String(h.targetField) } : {}),
            automatedRetryEligible: Boolean(h.automatedRetryEligible),
          }))
        : [],
      retryable: Boolean(embedded.retryable),
      fieldErrors: Array.isArray(embedded.fieldErrors) ? embedded.fieldErrors : [],
      correlationId: embedded.correlationId || payload.correlationId || null,
    };
  }

  const rawCode = String(payload.reasonCode || payload.code || '').trim();
  const known = CLIENT_REJECTION_CATALOG[rawCode] || CLIENT_REJECTION_CATALOG.UNEXPECTED_FAILURE;
  const reasonCode = rawCode in CLIENT_REJECTION_CATALOG ? rawCode : 'UNEXPECTED_FAILURE';
  const summary = sanitizeClientText(payload.error || payload.message, known.summary);
  const recoveryAction = sanitizeClientText(payload.recoveryAction, known.recoveryAction);

  return {
    schemaVersion: '1.0',
    reasonCode,
    category: payload.category || known.category,
    title: known.title,
    summary,
    recoveryAction,
    recoveryHints: [
      {
        step: 1,
        action: recoveryAction,
        automatedRetryEligible: Boolean(payload.retryable ?? known.retryable),
      },
    ],
    retryable: Boolean(payload.retryable ?? known.retryable),
    fieldErrors: Array.isArray(payload.fieldErrors) ? payload.fieldErrors : [],
    correlationId: payload.correlationId || null,
  };
}

module.exports = {
  CLIENT_REJECTION_CATALOG,
  resolveRejectionExplanation,
};
