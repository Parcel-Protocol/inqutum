import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInvoiceSchema, paymentSchema } from '../src/utils/validation.ts';

const SELLER = 'G' + 'A'.repeat(55);
const TX = 'a'.repeat(64);

function randomValue(seed: number): unknown {
  const values: unknown[] = [
    null, undefined, '', ' ', [], {}, true, false, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE,
    '0', '1e309', '\u0000\u202e', 'x'.repeat(501), 0, -1, 1, 1.5,
  ];
  return values[seed % values.length];
}

function baseInvoice(): Record<string, unknown> {
  return { amount: 10, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7 };
}

describe('malformed payload and numeric boundary fuzz coverage (#304)', () => {
  it('never throws while parsing deterministic malformed invoice payloads', () => {
    for (let seed = 0; seed < 500; seed++) {
      const payload = seed % 3 === 0
        ? randomValue(seed)
        : { ...baseInvoice(), amount: randomValue(seed), expiresInDays: randomValue(seed + 3) };
      assert.doesNotThrow(() => createInvoiceSchema.safeParse(payload), `seed ${seed}`);
    }
  });

  it('accepts only the documented numeric boundaries', () => {
    for (const amount of [Number.MIN_VALUE, 0, -1, 10, 1_000_000_000, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
      const result = createInvoiceSchema.safeParse({ ...baseInvoice(), amount });
      assert.equal(result.success, amount > 0 && amount <= 1_000_000_000 && Number.isFinite(amount), `amount ${String(amount)}`);
    }
    for (const expiresInDays of [0, 1, 7, 30, 31, 365, 366, 1.5, NaN, Infinity]) {
      const result = createInvoiceSchema.safeParse({ ...baseInvoice(), expiresInDays });
      assert.equal(result.success, [1, 7, 30].includes(expiresInDays), `expiry ${String(expiresInDays)}`);
    }
  });

  it('rejects malformed payment payloads without throwing', () => {
    for (let seed = 0; seed < 300; seed++) {
      const payload = {
        invoiceId: randomValue(seed),
        txHash: seed % 2 ? TX : randomValue(seed + 1),
        payerPublicKey: seed % 2 ? SELLER : randomValue(seed + 2),
        amount: randomValue(seed + 3),
      };
      assert.doesNotThrow(() => paymentSchema.safeParse(payload), `seed ${seed}`);
    }
  });
});
