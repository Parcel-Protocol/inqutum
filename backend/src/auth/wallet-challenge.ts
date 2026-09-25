import { Account, BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import {
  WALLET_CHALLENGE_MAX_SECONDS,
  WALLET_CHALLENGE_MIN_NONCE_BYTES,
  WALLET_CHALLENGE_OP_NAME,
} from '../../../shared/wallet-auth';

export type ChallengeRejection =
  | 'MALFORMED_CHALLENGE'
  | 'UNSUPPORTED_CHALLENGE'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_TOO_LONG'
  | 'BAD_SIGNATURE'
  | 'CHALLENGE_REPLAYED';

export type ChallengeResult =
  | { ok: true; wallet: string; challengeId: string; expiresAtMs: number }
  | { ok: false; code: ChallengeRejection; reason: string };

const reject = (code: ChallengeRejection, reason: string): ChallengeResult => ({ ok: false, code, reason });

/**
 * Builds an unsigned sign-in challenge. The server never needs this (the
 * client builds its own); it exists so tests, scripts and service clients build
 * the exact shape the verifier accepts.
 */
export function buildWalletChallenge(
  wallet: string,
  options: { networkPassphrase: string; nowMs?: number; validForSeconds?: number }
): string {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const validFor = options.validForSeconds ?? WALLET_CHALLENGE_MAX_SECONDS;
  // Sequence -1 becomes 0 once the builder increments it, which is what makes
  // the transaction impossible to submit.
  return new TransactionBuilder(new Account(wallet, '-1'), {
    fee: BASE_FEE,
    networkPassphrase: options.networkPassphrase,
    timebounds: { minTime: now, maxTime: now + validFor },
  })
    .addOperation(Operation.manageData({ name: WALLET_CHALLENGE_OP_NAME, value: randomBytes(32) }))
    .build()
    .toXDR();
}

/**
 * Remembers challenges already exchanged, so one signed challenge yields one
 * session. Entries are dropped once the challenge's own time bounds have
 * passed, after which the challenge is refused as expired anyway.
 *
 * In-process: with several server instances a challenge could be exchanged once
 * per instance inside its five-minute window. Session issuance is rate limited
 * and a session only grants what the wallet itself could already do, so this is
 * accepted; a shared store (Redis) is the upgrade if it ever matters.
 */
export class ChallengeReplayGuard {
  private readonly seen = new Map<string, number>();

  /** Records the challenge; returns false if it was already recorded. */
  claim(challengeId: string, expiresAtMs: number, nowMs: number = Date.now()): boolean {
    for (const [id, expiry] of this.seen) {
      if (expiry <= nowMs) this.seen.delete(id);
    }
    if (this.seen.has(challengeId)) return false;
    this.seen.set(challengeId, expiresAtMs);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

/**
 * Checks a signed challenge and returns the wallet it proves. Never throws on
 * bad input; every failure is a typed rejection so the route can answer with a
 * stable code.
 */
export function verifyWalletChallenge(
  xdr: unknown,
  options: { networkPassphrase: string; nowMs?: number; replayGuard?: ChallengeReplayGuard }
): ChallengeResult {
  if (typeof xdr !== 'string' || xdr.length === 0 || xdr.length > 8192) {
    return reject('MALFORMED_CHALLENGE', 'A signed challenge transaction is required');
  }

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(xdr, options.networkPassphrase);
  } catch {
    return reject('MALFORMED_CHALLENGE', 'The challenge is not a valid transaction for this network');
  }
  if ('innerTransaction' in tx) {
    return reject('UNSUPPORTED_CHALLENGE', 'Fee-bump transactions are not accepted');
  }

  const wallet = tx.source;
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return reject('UNSUPPORTED_CHALLENGE', 'The challenge source must be an ordinary Stellar account');
  }
  const [operation] = tx.operations;
  const shapeOk =
    tx.operations.length === 1 &&
    tx.sequence === '0' &&
    (!tx.memo || tx.memo.type === 'none') &&
    operation.type === 'manageData' &&
    operation.name === WALLET_CHALLENGE_OP_NAME &&
    Buffer.isBuffer(operation.value) &&
    operation.value.length >= WALLET_CHALLENGE_MIN_NONCE_BYTES &&
    (!operation.source || operation.source === wallet);
  if (!shapeOk) {
    return reject('UNSUPPORTED_CHALLENGE', 'This transaction is not an inqutum sign-in challenge');
  }

  const minTime = Number(tx.timeBounds?.minTime);
  const maxTime = Number(tx.timeBounds?.maxTime);
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime) || maxTime === 0) {
    return reject('CHALLENGE_EXPIRED', 'The challenge has no time bounds');
  }
  if (maxTime - minTime > WALLET_CHALLENGE_MAX_SECONDS) {
    return reject('CHALLENGE_TOO_LONG', `The challenge may be valid for at most ${WALLET_CHALLENGE_MAX_SECONDS} seconds`);
  }
  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowSeconds < minTime || nowSeconds > maxTime) {
    return reject('CHALLENGE_EXPIRED', 'The challenge is outside its validity window');
  }

  const keypair = Keypair.fromPublicKey(wallet);
  const hash = tx.hash();
  const signedBySource = tx.signatures.some((signature) => {
    try {
      return keypair.verify(hash, signature.signature());
    } catch {
      return false;
    }
  });
  if (!signedBySource) {
    return reject('BAD_SIGNATURE', 'The challenge is not signed by the account it names');
  }

  const challengeId = hash.toString('hex');
  const expiresAtMs = maxTime * 1000;
  if (options.replayGuard && !options.replayGuard.claim(challengeId, expiresAtMs, nowMs)) {
    return reject('CHALLENGE_REPLAYED', 'This challenge has already been used');
  }
  return { ok: true, wallet, challengeId, expiresAtMs };
}
