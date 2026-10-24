/**
 * Pure contract logic for the UserProfile boundary (issue #170).
 *
 * Extracts testable wallet-display, address-truncation, and disconnect-safety
 * logic from UserProfile.tsx so the component boundary can be regression-tested
 * without a DOM.
 */

/**
 * Checks whether a wallet address is suitable for profile display.
 *
 * Time:  O(1)
 * Space: O(1)
 *
 * @param {any} wallet
 * @returns {boolean}
 */
function isDisplayableWallet(wallet) {
  return typeof wallet === 'string' && wallet.length > 0;
}

/**
 * Truncates a Stellar wallet address for UI display.
 * Returns the full string when it is shorter than the truncation window.
 * Returns empty string for non-string or empty input.
 *
 * Time:  O(1) — substring is bounded by constant prefix/suffix lengths
 * Space: O(1)
 *
 * @param {any} wallet
 * @param {number} [prefixLen=6]
 * @param {number} [suffixLen=4]
 * @returns {string}
 */
function truncateWalletAddress(wallet, prefixLen = 6, suffixLen = 4) {
  if (typeof wallet !== 'string' || wallet.length === 0) return '';
  const minLen = prefixLen + suffixLen + 1;
  if (wallet.length < minLen) return wallet;
  return `${wallet.substring(0, prefixLen)}...${wallet.substring(wallet.length - suffixLen)}`;
}

/**
 * Safely executes the disconnect flow, catching callback errors so they
 * cannot leave the UI in a partially-disconnected state.
 *
 * @param {() => void} disconnectStore
 * @param {(() => void) | undefined | null} onDisconnect
 * @returns {{ ok: boolean; error?: string }}
 */
function safeDisconnect(disconnectStore, onDisconnect) {
  disconnectStore();
  if (typeof onDisconnect === 'function') {
    try {
      onDisconnect();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Disconnect callback failed' };
    }
  }
  return { ok: true };
}

module.exports = {
  isDisplayableWallet,
  truncateWalletAddress,
  safeDisconnect,
};
