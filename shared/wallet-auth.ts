/**
 * Constants of the wallet sign-in handshake, shared so the client that builds
 * the challenge and the server that checks it cannot drift apart.
 *
 * The handshake (SEP-10 in spirit, self-issued): the client builds a Stellar
 * transaction that is never submitted, signs it with the wallet, and posts it to
 * `POST /api/auth/session`. The server accepts it as proof of key ownership and
 * returns a short-lived session token. The transaction must be:
 *
 *   - sourced from the wallet being proven, sequence number 0;
 *   - a single `manageData` operation named WALLET_CHALLENGE_OP_NAME whose value
 *     is a random nonce, with no memo;
 *   - bounded by time bounds that are open for at most WALLET_CHALLENGE_MAX_SECONDS;
 *   - signed by the source account.
 *
 * Because the transaction has sequence 0 it can never be valid on the ledger,
 * so a leaked challenge cannot move funds; it can only be replayed against this
 * endpoint, which the server refuses (each challenge is single use).
 */

/** Name of the manageData operation that marks a transaction as a sign-in challenge. */
export const WALLET_CHALLENGE_OP_NAME = 'inqutum auth';

/** A challenge's time bounds may span at most this many seconds. */
export const WALLET_CHALLENGE_MAX_SECONDS = 300;

/** Minimum nonce length in bytes; the client uses 32. */
export const WALLET_CHALLENGE_MIN_NONCE_BYTES = 16;

/** How long a session token lasts unless the server is configured otherwise. */
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;

/** Prefix of tokens the server issues, so a static API token is never mistaken for one. */
export const SESSION_TOKEN_PREFIX = 'iq1';
