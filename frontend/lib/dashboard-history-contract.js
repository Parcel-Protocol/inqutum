/**
 * Hardened contract for the dashboard history boundary (issue #232)..
 *
 * Defines success, validation, retry, and degraded-dependency behavior for
 * dashboard data scoping. A failure here can make invoice or payment-proof
 * state misleading, or leave a user without a safe recovery path.
 *
 * Preserves the stable response and error-code conventions shared by the MVP
 * and persistent paths.
 */

const { isStellarPublicKey } = require('./stellar-network');

/**
 * Error codes for dashboard history operations.
 * Stable conventions shared by MVP and persistent paths.
 */
const DASHBOARD_ERROR_CODES = Object.freeze({
  INVALID_KEY: 'INVALID_KEY',
  MALFORMED_DATA: 'MALFORMED_DATA',
  OWNER_MISMATCH: 'OWNER_MISMATCH',
  DEGRADED: 'DEGRADED',
});

/**
 * Validates a Stellar public key for dashboard scoping.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} publicKey
 * @returns {boolean}
 */
function isValidSellerKey(publicKey) {
  if (typeof publicKey !== 'string') return false;
  return isStellarPublicKey(publicKey.trim());
}

/**
 * Validates an invoice object for ownership checks.
 *
 * Ensures the invoice has the required structure for scoping without
 * throwing on malformed data.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} invoice
 * @returns {boolean}
 */
function isValidInvoiceStructure(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  if (Array.isArray(invoice)) return false;
  return typeof invoice.sellerPublicKey === 'string';
}

/**
 * Hardened version of belongsToSeller with input validation.
 *
 * Returns false for any invalid input instead of throwing, providing
 * a fail-closed boundary for dashboard scoping.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} invoice
 * @param {any} sellerPublicKey
 * @returns {boolean}
 */
function belongsToSeller(invoice, sellerPublicKey) {
  if (!isValidInvoiceStructure(invoice)) return false;
  if (!isValidSellerKey(sellerPublicKey)) return false;
  return invoice.sellerPublicKey === sellerPublicKey;
}

/**
 * Validates dashboard data structure from the backend.
 *
 * Ensures the data object has the expected shape before processing.
 * Fails closed for malformed responses.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} data
 * @returns {boolean}
 */
function isValidDashboardData(data) {
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data)) return false;
  if (typeof data.owner !== 'string') return false;
  if (!Array.isArray(data.invoices)) return false;
  return true;
}

/**
 * Classifies a dashboard data validation error.
 *
 * Distinguishes between:
 * - INVALID_KEY: malformed public key
 * - MALFORMED_DATA: unexpected data structure
 * - OWNER_MISMATCH: data belongs to a different wallet
 * - DEGRADED: backend response is unreliable
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} error
 * @returns {string}
 */
function classifyDashboardError(error) {
  if (error?.code === DASHBOARD_ERROR_CODES.INVALID_KEY) {
    return DASHBOARD_ERROR_CODES.INVALID_KEY;
  }
  if (error?.code === DASHBOARD_ERROR_CODES.MALFORMED_DATA) {
    return DASHBOARD_ERROR_CODES.MALFORMED_DATA;
  }
  if (error?.code === DASHBOARD_ERROR_CODES.OWNER_MISMATCH) {
    return DASHBOARD_ERROR_CODES.OWNER_MISMATCH;
  }
  return DASHBOARD_ERROR_CODES.DEGRADED;
}

/**
 * Returns a user-facing message for a dashboard error code.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {string} errorCode
 * @returns {string}
 */
function describeDashboardError(errorCode) {
  switch (errorCode) {
    case DASHBOARD_ERROR_CODES.INVALID_KEY:
      return 'Invalid wallet address format.';
    case DASHBOARD_ERROR_CODES.MALFORMED_DATA:
      return 'Unable to process invoice data.';
    case DASHBOARD_ERROR_CODES.OWNER_MISMATCH:
      return 'Data does not match connected wallet.';
    case DASHBOARD_ERROR_CODES.DEGRADED:
    default:
      return 'Dashboard data temporarily unavailable.';
  }
}

/**
 * Safe fallback for dashboard data when validation fails.
 *
 * Returns an empty dashboard structure that is safe to render
 * without exposing misleading state.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @returns {{ invoices: []; stats: null }}
 */
function safeDashboardFallback() {
  return { invoices: [], stats: null };
}

/**
 * Validates seller public key and returns error details if invalid.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} sellerPublicKey
 * @returns {{ valid: boolean; error?: { code: string; message: string } }}
 */
function validateSellerPublicKey(sellerPublicKey) {
  if (!isValidSellerKey(sellerPublicKey)) {
    return {
      valid: false,
      error: {
        code: DASHBOARD_ERROR_CODES.INVALID_KEY,
        message: describeDashboardError(DASHBOARD_ERROR_CODES.INVALID_KEY),
      },
    };
  }
  return { valid: true };
}

/**
 * Validates dashboard data structure and returns error details if invalid.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} data
 * @returns {{ valid: boolean; error?: { code: string; message: string } }}
 */
function validateDashboardDataStructure(data) {
  if (!isValidDashboardData(data)) {
    return {
      valid: false,
      error: {
        code: DASHBOARD_ERROR_CODES.MALFORMED_DATA,
        message: describeDashboardError(DASHBOARD_ERROR_CODES.MALFORMED_DATA),
      },
    };
  }
  return { valid: true };
}

/**
 * Checks if dashboard data ownership matches the connected wallet.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} data
 * @param {string} sellerPublicKey
 * @returns {boolean}
 */
function isDataOwnerMatch(data, sellerPublicKey) {
  if (!isValidDashboardData(data)) return false;
  if (!isValidSellerKey(sellerPublicKey)) return false;
  return data.owner === sellerPublicKey;
}

/**
 * Executes the dashboard data validation contract with dependency injection.
 *
 * This is the primary entry point for hardened dashboard data processing.
 * It validates inputs, checks ownership, and provides safe fallbacks for
 * degraded states.
 *
 * Time:  O(1) for validation, O(n) for invoice scoping where n = invoice count
 * Space: O(n) for scoped invoices
 *
 * @param {object} deps
 * @param {(invoices: any[], sellerPublicKey: string) => any[]} deps.scopeInvoicesToSeller
 * @param {(invoices: any[], now: any) => any[]} deps.applyExpiryLifecycle
 * @param {(stats: any, original: any[], projected: any[]) => any} deps.reconcileExpiryStats
 * @param {() => { invoices: []; stats: null }} deps.emptyDashboardData
 * @param {any} data
 * @param {string} sellerPublicKey
 * @param {any} [now]
 * @returns {{
 *   ok: boolean;
 *   data?: { invoices: any[]; stats: any };
 *   error?: { code: string; message: string };
 * }}
 */
function executeDashboardDataContract(deps, data, sellerPublicKey, now) {
  const keyValidation = validateSellerPublicKey(sellerPublicKey);
  if (!keyValidation.valid) {
    return {
      ok: false,
      data: safeDashboardFallback(),
      error: keyValidation.error,
    };
  }

  if (!data) {
    return {
      ok: true,
      data: safeDashboardFallback(),
    };
  }

  const dataValidation = validateDashboardDataStructure(data);
  if (!dataValidation.valid) {
    return {
      ok: false,
      data: safeDashboardFallback(),
      error: dataValidation.error,
    };
  }

  if (!isDataOwnerMatch(data, sellerPublicKey)) {
    return {
      ok: false,
      data: safeDashboardFallback(),
      error: {
        code: DASHBOARD_ERROR_CODES.OWNER_MISMATCH,
        message: describeDashboardError(DASHBOARD_ERROR_CODES.OWNER_MISMATCH),
      },
    };
  }

  try {
    const owned = deps.scopeInvoicesToSeller(data.invoices, sellerPublicKey);
    const invoices = deps.applyExpiryLifecycle(owned, now);
    const stats = deps.reconcileExpiryStats(data.stats, owned, invoices);

    return {
      ok: true,
      data: { invoices, stats },
    };
  } catch (error) {
    return {
      ok: false,
      data: safeDashboardFallback(),
      error: {
        code: DASHBOARD_ERROR_CODES.DEGRADED,
        message: describeDashboardError(DASHBOARD_ERROR_CODES.DEGRADED),
      },
    };
  }
}

module.exports = {
  DASHBOARD_ERROR_CODES,
  isValidSellerKey,
  isValidInvoiceStructure,
  belongsToSeller,
  isValidDashboardData,
  classifyDashboardError,
  describeDashboardError,
  safeDashboardFallback,
  validateSellerPublicKey,
  validateDashboardDataStructure,
  isDataOwnerMatch,
  executeDashboardDataContract,
};
