import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalCancelMessage, canonicalSerialize } from '../src/utils/canonical-serialization';
import { Keypair } from '@stellar/stellar-sdk';
import { verifySellerSignature } from '../src/utils/signature-verification';

test('canonical serialization fixes key ordering, whitespace, casing and decimal precision', () => {
  const left = canonicalSerialize({ assetCode: ' usdc ', amount: '001.2300', memo: '  Client\tinvoice ', txHash: 'ABCD', z: 1, a: true });
  const right = canonicalSerialize({ z: 1, txHash: 'abcd', memo: 'Client invoice', a: true, amount: '1.23', assetCode: 'USDC' });
  assert.equal(left, right);
  assert.equal(left, '{"a":true,"amount":"1.23","assetCode":"USDC","memo":"Client invoice","txHash":"abcd","z":1}');
});

test('canonical cancellation messages are stable for equivalent input', () => {
  assert.equal(
    canonicalCancelMessage(' ABCD-EF ', 'gabc'),
    canonicalCancelMessage('abcd-ef', 'GABC'),
  );
});

test('a canonical cancellation signature verifies and legacy messages remain supported', () => {
  const signer = Keypair.random();
  const message = canonicalCancelMessage(' INVOICE-A ', signer.publicKey().toLowerCase());
  const signature = signer.sign(Buffer.from(message)).toString('base64');
  assert.equal(verifySellerSignature(signer.publicKey(), signature, [message]), true);
  const legacy = signer.sign(Buffer.from('invoice-a')).toString('hex');
  assert.equal(verifySellerSignature(signer.publicKey(), legacy, [message, 'invoice-a']), true);
});

test('canonical serialization rejects non-finite numbers', () => {
  assert.throws(() => canonicalSerialize({ amount: Number.NaN }));
});
