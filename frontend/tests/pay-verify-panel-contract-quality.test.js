const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TX_HASH_LENGTH,
  VERIFY_ERRORS,
  validateTxHash,
  classifyVerifyError,
  executeVerifyContract,
} = require('../lib/pay-verify-panel-contract');

const VALID_HASH = 'b'.repeat(64);

// ---------------------------------------------------------------- validateTxHash edge cases

test('validateTxHash rejects hash with mixed valid and invalid chars', () => {
  const r = validateTxHash('z' + 'a'.repeat(63));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_CHARS');
});

test('validateTxHash rejects number input', () => {
  const r = validateTxHash(1234567890);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EMPTY');
});

test('validateTxHash rejects object input', () => {
  const r = validateTxHash({});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EMPTY');
});

test('validateTxHash hash property matches the trimmed input', () => {
  const hash = 'f'.repeat(TX_HASH_LENGTH);
  const r = validateTxHash(`  ${hash}  `);
  assert.equal(r.ok, true);
  assert.equal(r.hash.length, TX_HASH_LENGTH);
  assert.equal(r.hash, hash);
});

test('validateTxHash rejects hash of exactly 63 chars (boundary)', () => {
  const r = validateTxHash('a'.repeat(63));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_LENGTH');
});

test('validateTxHash accepts hash of exactly 64 chars (boundary)', () => {
  const r = validateTxHash('a'.repeat(64));
  assert.equal(r.ok, true);
});

test('validateTxHash rejects hash of exactly 65 chars (boundary)', () => {
  const r = validateTxHash('a'.repeat(65));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_LENGTH');
});

// ---------------------------------------------------------------- classifyVerifyError edge cases

test('classifyVerifyError returns NETWORK for fetch-failed message', () => {
  assert.equal(classifyVerifyError(new Error('fetch failed')), VERIFY_ERRORS.NETWORK);
});

test('classifyVerifyError returns VERIFY_FAILED for 404 message', () => {
  assert.equal(classifyVerifyError(new Error('404 not found')), VERIFY_ERRORS.VERIFY_FAILED);
});

test('classifyVerifyError handles plain string errors', () => {
  const result = classifyVerifyError('some error string');
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('VERIFY_ERRORS values are non-empty strings', () => {
  for (const [key, value] of Object.entries(VERIFY_ERRORS)) {
    assert.ok(typeof value === 'string' && value.length > 0, `VERIFY_ERRORS.${key} should be non-empty`);
  }
});

test('VERIFY_ERRORS is frozen', () => {
  assert.throws(() => {
    'use strict';
    VERIFY_ERRORS.EMPTY = 'mutated';
  });
});

// ---------------------------------------------------------------- executeVerifyContract edge cases

test('executeVerifyContract does not call onVerify when hash is invalid chars', async () => {
  let onVerifyCalled = false;
  const r = await executeVerifyContract(
    { onVerify: async () => { onVerifyCalled = true; return true; } },
    'z'.repeat(64)
  );
  assert.equal(r.success, false);
  assert.equal(onVerifyCalled, false);
  assert.equal(r.error, VERIFY_ERRORS.INVALID_CHARS);
});

test('executeVerifyContract degraded: network timeout surfaces NETWORK error', async () => {
  let errMsg = null;
  const r = await executeVerifyContract(
    {
      onVerify: async () => { throw new Error('timeout after 30s'); },
      onError: (m) => { errMsg = m; },
    },
    VALID_HASH
  );
  assert.equal(r.success, false);
  assert.equal(r.shouldFocusInput, true);
  assert.equal(errMsg, VERIFY_ERRORS.NETWORK);
});

test('executeVerifyContract degraded: unavailable service surfaces NETWORK error', async () => {
  const r = await executeVerifyContract(
    { onVerify: async () => { throw new Error('service unavailable'); } },
    VALID_HASH
  );
  assert.equal(r.success, false);
  assert.equal(r.error, VERIFY_ERRORS.NETWORK);
});

test('executeVerifyContract: shouldFocusInput is true on every failure path', async () => {
  const cases = [
    { hash: '', label: 'empty' },
    { hash: 'abc', label: 'short' },
    { hash: 'z'.repeat(64), label: 'invalid chars' },
  ];

  for (const { hash, label } of cases) {
    const r = await executeVerifyContract({ onVerify: async () => true }, hash);
    assert.equal(r.shouldFocusInput, true, `shouldFocusInput should be true for ${label}`);
  }
});

test('executeVerifyContract: success path sets shouldFocusInput to undefined', async () => {
  const r = await executeVerifyContract(
    { onVerify: async () => true },
    VALID_HASH
  );
  assert.equal(r.success, true);
  assert.equal(r.shouldFocusInput, undefined);
  assert.equal(r.error, undefined);
});
