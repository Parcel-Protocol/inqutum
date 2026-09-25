import { Account, BASE_FEE, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  WALLET_CHALLENGE_MAX_SECONDS,
  WALLET_CHALLENGE_OP_NAME,
} from '../../shared/wallet-auth.ts';

/**
 * Builds the sign-in challenge the server exchanges for a session token
 * (`POST /api/auth/session`, see docs/ACCESS-CONTROL.md).
 *
 * It is a Stellar transaction that is never submitted: sequence 0 makes it
 * impossible to apply on the ledger, so signing it cannot move funds. Freighter
 * shows the prompt, the wallet signs, and the server checks the signature to
 * learn which account the caller controls.
 *
 * The shape is fixed by shared/wallet-auth.ts and enforced by the server's
 * verifier; change either side only together.
 */
export function buildWalletChallenge(
  publicKey: string,
  options: { networkPassphrase: string; nowMs?: number; validForSeconds?: number }
): string {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const validFor = options.validForSeconds ?? WALLET_CHALLENGE_MAX_SECONDS;

  const nonce = new Uint8Array(24);
  crypto.getRandomValues(nonce);
  const nonceHex = Array.from(nonce, (byte) => byte.toString(16).padStart(2, '0')).join('');

  // Sequence -1 becomes 0 when the builder increments it.
  return new TransactionBuilder(new Account(publicKey, '-1'), {
    fee: BASE_FEE,
    networkPassphrase: options.networkPassphrase,
    timebounds: { minTime: now, maxTime: now + validFor },
  })
    .addOperation(Operation.manageData({ name: WALLET_CHALLENGE_OP_NAME, value: nonceHex }))
    .build()
    .toXDR();
}
