/**
 * Idempotency store contract (issue #44).
 *
 * A client that retries a write with the same `Idempotency-Key` must get the
 * outcome of the first attempt instead of running the side effects again. The
 * store is what remembers the first attempt. `begin` is the single atomic step
 * that decides what a request is:
 *
 *   new          nobody has used this key: the caller now owns it and must call
 *                `complete` (success) or `release` (anything else).
 *   replay       a previous attempt succeeded: answer with its stored response.
 *   in_progress  another request holding this key has not finished yet.
 *   conflict     the key was used for a *different* request (other route or body).
 *   expired      the key was used, but longer ago than the retention window.
 *
 * Only successful (2xx) outcomes are stored. A failed attempt is released, so a
 * retry runs again: replaying a transient failure (a Horizon lookup that had not
 * indexed the transaction yet, a timeout) would trap the client in it forever.
 * This is safe because every failure path in these handlers leaves no side
 * effect behind; the invoice lifecycle guards the ones that could.
 */

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an unfinished attempt is trusted before another request may take over. */
export const DEFAULT_IDEMPOTENCY_LOCK_MS = 60 * 1000;
/** Expired keys are kept this long past expiry so a late retry gets a clear error. */
export const IDEMPOTENCY_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface BeginInput {
  /** Who is asking: keys are private to an actor, so two actors may reuse a string. */
  scope: string;
  key: string;
  /** Hash of what the request is (method, path, canonical body). */
  fingerprint: string;
  now: Date;
  ttlMs: number;
  lockMs: number;
}

export type BeginResult =
  | { kind: 'new' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'in_progress' }
  | { kind: 'conflict' }
  | { kind: 'expired' };

export interface IdempotencyStore {
  begin(input: BeginInput): Promise<BeginResult>;
  /** Records the outcome of a request this caller owns, making it replayable. */
  complete(scope: string, key: string, response: StoredResponse, now: Date): Promise<void>;
  /** Gives up an owned key so a retry runs again. No effect on a completed key. */
  release(scope: string, key: string): Promise<void>;
  /** Removes keys expired for longer than the tombstone window. Returns how many. */
  purge(now: Date): Promise<number>;
}
