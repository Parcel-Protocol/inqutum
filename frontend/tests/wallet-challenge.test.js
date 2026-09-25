const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Networks, TransactionBuilder } = require('@stellar/stellar-sdk');
const { buildWalletChallenge } = require('../lib/wallet-challenge.ts');
const {
  WALLET_CHALLENGE_MAX_SECONDS,
  WALLET_CHALLENGE_MIN_NONCE_BYTES,
  WALLET_CHALLENGE_OP_NAME,
} = require('../../shared/wallet-auth.ts');

const keypair = Keypair.random();
const build = (options = {}) =>
  buildWalletChallenge(keypair.publicKey(), { networkPassphrase: Networks.TESTNET, ...options });

// These assertions restate the rules the server's verifier enforces
// (backend/src/auth/wallet-challenge.ts), so a client change that the server
// would reject fails here instead of at sign-in.
test('builds a sequence-0 transaction that can never be applied to the ledger', () => {
  const tx = TransactionBuilder.fromXDR(build(), Networks.TESTNET);
  assert.equal(tx.source, keypair.publicKey());
  assert.equal(tx.sequence, '0');
});

test('carries one manageData operation with the agreed name and a nonce', () => {
  const tx = TransactionBuilder.fromXDR(build(), Networks.TESTNET);
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0].type, 'manageData');
  assert.equal(tx.operations[0].name, WALLET_CHALLENGE_OP_NAME);
  assert.ok(tx.operations[0].value.length >= WALLET_CHALLENGE_MIN_NONCE_BYTES);
});

test('uses a fresh nonce every time, so a challenge cannot be predicted', () => {
  const nonce = () => TransactionBuilder.fromXDR(build(), Networks.TESTNET).operations[0].value.toString('hex');
  assert.notEqual(nonce(), nonce());
});

test('is open for no longer than the server accepts', () => {
  const now = 1_800_000_000_000;
  const tx = TransactionBuilder.fromXDR(build({ nowMs: now }), Networks.TESTNET);
  assert.equal(Number(tx.timeBounds.minTime), now / 1000);
  assert.ok(Number(tx.timeBounds.maxTime) - Number(tx.timeBounds.minTime) <= WALLET_CHALLENGE_MAX_SECONDS);
});

test('has no memo and no fee-bump wrapper', () => {
  const tx = TransactionBuilder.fromXDR(build(), Networks.TESTNET);
  assert.equal(tx.memo.type, 'none');
  assert.equal('innerTransaction' in tx, false);
});
