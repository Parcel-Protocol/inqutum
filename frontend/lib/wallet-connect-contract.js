/**
 * Pure contract logic for the WalletConnect boundary (issue #171).
 *
 * Extracts testable balance-resolution, error-classification, and
 * degraded-dependency handling from WalletConnect.tsx so the component
 * boundary can be regression-tested without a DOM.
 */

const BALANCE_ERROR_CODES = Object.freeze({
  UNFUNDED: 'UNFUNDED',
  DEGRADED: 'DEGRADED',
});

/**
 * Resolves the XLM balance string from a Horizon balances array.
 *
 * Time:  O(n) where n = number of balance entries (typically ≤ 20)
 * Space: O(1)
 *
 * @param {Array<{assetCode: string, balance: string}>} balances
 * @returns {string} formatted two-decimal balance or '0.00'
 */
function resolveXlmBalance(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return '0.00';
  const xlm = balances.find((b) => b && b.assetCode === 'XLM');
  if (!xlm || typeof xlm.balance !== 'string') return '0.00';
  const parsed = parseFloat(xlm.balance);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : '0.00';
}

/**
 * Classifies a Horizon balance-fetch error into an actionable code.
 *
 * - UNFUNDED: account exists on-chain but has no XLM (404 from Horizon).
 * - DEGRADED: Horizon is unreachable or returned a transient error.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} error
 * @returns {'UNFUNDED' | 'DEGRADED'}
 */
function classifyBalanceError(error) {
  if (error?.message?.includes('Not Found') || error?.response?.status === 404) {
    return BALANCE_ERROR_CODES.UNFUNDED;
  }
  return BALANCE_ERROR_CODES.DEGRADED;
}

/**
 * Returns a store-safe numeric balance string for a given error classification.
 * The store rejects non-numeric values, so we always return '0'.
 *
 * @param {'UNFUNDED' | 'DEGRADED'} _errorCode
 * @returns {string}
 */
function safeBalanceFallback(_errorCode) {
  return '0';
}

/**
 * Returns user-facing toast metadata for a balance error classification.
 *
 * @param {'UNFUNDED' | 'DEGRADED'} errorCode
 * @param {(error: any) => string} [describeNetworkError]
 * @param {any} [error]
 * @returns {{ type: 'warning'; message: string; description?: string }}
 */
function balanceErrorToast(errorCode, describeNetworkError, error) {
  if (errorCode === BALANCE_ERROR_CODES.UNFUNDED) {
    return { type: 'warning', message: 'Account needs funding' };
  }
  return {
    type: 'warning',
    message: 'Wallet connected; balance unavailable',
    description: typeof describeNetworkError === 'function'
      ? describeNetworkError(error)
      : 'Stellar network request failed.',
  };
}

/**
 * Executes the WalletConnect balance-loading contract with dependency injection.
 *
 * @param {object} deps
 * @param {(key: string) => Promise<Array<{assetCode: string, balance: string}>>} deps.getAccountBalance
 * @param {(key: string, balance: string) => any} deps.setWallet
 * @param {(error: any) => string} [deps.describeNetworkError]
 * @param {{ warning?: (msg: string, opts?: any) => void }} [deps.toast]
 * @param {string} key - Stellar public key
 * @returns {Promise<{ ok: boolean; balance: string; errorCode?: string }>}
 */
async function executeLoadBalance(deps, key) {
  try {
    const balances = await deps.getAccountBalance(key);
    const balance = resolveXlmBalance(balances);
    deps.setWallet(key, balance);
    return { ok: true, balance };
  } catch (error) {
    const errorCode = classifyBalanceError(error);
    const fallback = safeBalanceFallback(errorCode);
    deps.setWallet(key, fallback);
    const toastMeta = balanceErrorToast(errorCode, deps.describeNetworkError, error);
    deps.toast?.warning?.(toastMeta.message, {
      description: toastMeta.description,
    });
    return { ok: false, balance: fallback, errorCode };
  }
}

module.exports = {
  BALANCE_ERROR_CODES,
  resolveXlmBalance,
  classifyBalanceError,
  safeBalanceFallback,
  balanceErrorToast,
  executeLoadBalance,
};
