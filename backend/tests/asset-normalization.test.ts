import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as StellarSdk from '@stellar/stellar-sdk';
import { createInvoiceSchema, assetCodeSchema, assetIssuerSchema } from '../src/utils/validation';
import { verifyHorizonPayment } from '../src/services/payment-verification';
import { resolveInvoiceAsset, resolvePaymentAsset, assetsMatch } from '../src/utils/asset-helpers';

// Issue #8: friendly normalization at creation, strict comparison at verification.

const SELLER = StellarSdk.Keypair.random().publicKey();
const ISSUER = StellarSdk.Keypair.random().publicKey();
const OTHER_ISSUER = StellarSdk.Keypair.random().publicKey();
const TX_HASH = 'a1b2c3d4'.repeat(8);

function create(fields: Record<string, unknown>) {
  return createInvoiceSchema.safeParse({ amount: 10, sellerPublicKey: SELLER, ...fields });
}

describe('invoice creation normalizes and validates the asset', () => {
  it('uppercases and trims the asset code', () => {
    for (const typed of ['usdc', 'UsDc', '  usdc  ', 'USDC']) {
      const result = create({ assetCode: typed, assetIssuer: ISSUER });
      assert.equal(result.success, true, typed);
      assert.equal(result.success && result.data.assetCode, 'USDC');
    }
  });

  it('normalizes a lowercase native code and keeps it issuer-free', () => {
    const result = create({ assetCode: 'xlm' });
    assert.equal(result.success && result.data.assetCode, 'XLM');
    assert.equal(create({ assetCode: 'xlm', assetIssuer: ISSUER }).success, false);
  });

  it('leaves an omitted code untouched (callers default it to XLM)', () => {
    const result = create({});
    assert.equal(result.success, true);
    assert.ok(!result.success || result.data.assetCode === undefined || result.data.assetCode === 'XLM');
  });

  it('rejects codes that are not 1-12 alphanumerics', () => {
    for (const bad of ['', '   ', 'US DC', 'US-DC', 'USDC!', 'A'.repeat(13), 'ÜSDC']) {
      assert.equal(assetCodeSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.equal(assetCodeSchema.safeParse('A'.repeat(12)).success, true);
  });

  it('still requires an issuer for issued assets', () => {
    assert.equal(create({ assetCode: 'usdc' }).success, false);
  });

  it('rejects malformed issuer keys up front', () => {
    const valid = ISSUER;
    // Right shape, wrong checksum (last character changed).
    const badChecksum = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    const cases = [
      badChecksum,
      valid.toLowerCase(),
      ` ${valid}`,
      valid.slice(0, 55),
      `M${valid.slice(1)}`,
      StellarSdk.StrKey.encodeSha256Hash(Buffer.alloc(32)),
      'not-a-key',
    ];
    for (const bad of cases) {
      assert.equal(assetIssuerSchema.safeParse(bad).success, false, bad);
      assert.equal(create({ assetCode: 'USDC', assetIssuer: bad }).success, false, bad);
    }
    assert.equal(assetIssuerSchema.safeParse(valid).success, true);
  });
});

describe('verification compares code and issuer exactly', () => {
  const expected = (overrides = {}) => ({
    memo: 'INV-1',
    amount: '10.0000000',
    destination: SELLER,
    assetCode: 'USDC',
    assetIssuer: ISSUER,
    ...overrides,
  });
  const op = (overrides = {}) => ({
    type: 'payment',
    to: SELLER,
    amount: '10.0000000',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: ISSUER,
    ...overrides,
  });
  const verify = (exp = expected(), operation = op()) =>
    verifyHorizonPayment({
      txHash: TX_HASH,
      expected: exp,
      transaction: { memo: 'INV-1', memo_type: 'text' },
      operations: [operation],
    });

  it('accepts the exact code and issuer', () => {
    assert.equal(verify().ok, true);
  });

  it('rejects a payment to a different issuer', () => {
    const result = verify(expected(), op({ asset_issuer: OTHER_ISSUER }));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'ASSET_MISMATCH');
  });

  it('rejects a differently-cased code on the payment', () => {
    const result = verify(expected(), op({ asset_code: 'usdc' }));
    assert.equal(!result.ok && result.code, 'ASSET_MISMATCH');
  });

  it('does not normalize an invoice code at verification time', () => {
    const result = verify(expected({ assetCode: 'usdc' }));
    assert.equal(!result.ok && result.code, 'ASSET_MISMATCH');
  });

  it('never folds the case of the issuer key', () => {
    const result = verify(expected(), op({ asset_issuer: ISSUER.toLowerCase() }));
    assert.equal(!result.ok && result.code, 'ASSET_MISMATCH');
  });

  it('does not trim whitespace on either side', () => {
    assert.equal(
      assetsMatch(
        resolveInvoiceAsset({ assetCode: 'USDC', assetIssuer: ISSUER }),
        resolvePaymentAsset({ assetType: 'credit_alphanum4', assetCode: 'USDC ', assetIssuer: ISSUER }),
      ),
      false,
    );
    assert.equal(
      assetsMatch(
        resolveInvoiceAsset({ assetCode: 'USDC', assetIssuer: ` ${ISSUER}` }),
        resolvePaymentAsset({ assetType: 'credit_alphanum4', assetCode: 'USDC', assetIssuer: ISSUER }),
      ),
      false,
    );
  });

  it('a normalized create followed by a payment in the typed case settles only in canonical case', () => {
    const created = create({ assetCode: 'usdc', assetIssuer: ISSUER });
    assert.equal(created.success, true);
    const stored = created.success ? created.data : null;
    assert.ok(stored);
    assert.equal(verify(expected({ assetCode: stored.assetCode, assetIssuer: stored.assetIssuer })).ok, true);
  });
});
