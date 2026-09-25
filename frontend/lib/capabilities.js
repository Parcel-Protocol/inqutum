/**
 * What the UI offers the current user, derived from the same role/permission
 * table the server enforces (shared/access-control.ts).
 *
 * This decides what to *show*. It is never the security boundary: an action the
 * UI hides is still refused by the API if someone calls it directly, and an
 * action the UI shows can still be refused (an expired session, say).
 */

const { can, isOwnershipScoped } = require('../../shared/access-control.ts');

/** A connected wallet is an end user once it signs in; otherwise the visitor is a payer. */
function roleForSession(session) {
  return session && session.connected && session.publicKey ? 'end_user' : 'anonymous';
}

/**
 * Whether `role` may use `permission`, applying the ownership rule for
 * permissions that only cover a user's own invoices.
 *
 * @param {string} role
 * @param {string} permission
 * @param {{ wallet?: string | null, sellerPublicKey?: string | null }} [resource]
 */
function canDo(role, permission, resource = {}) {
  if (!can(role, permission)) return false;
  if (!isOwnershipScoped(role, permission)) return true;
  return Boolean(resource.wallet) && resource.wallet === resource.sellerPublicKey;
}

module.exports = { roleForSession, canDo };
