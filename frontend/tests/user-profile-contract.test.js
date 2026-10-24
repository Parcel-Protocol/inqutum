const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDisplayableWallet,
  truncateWalletAddress,
  safeDisconnect,
} = require('../lib/user-profile-contract');

// ─── isDisplayableWallet ─────────────────────────────────────────────────────

test('isDisplayableWallet accepts a valid Stellar public key', () => {
  assert.equal(isDisplayableWallet('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'), true);
});

test('isDisplayableWallet accepts a short non-empty string', () => {
  assert.equal(isDisplayableWallet('G'), true);
});

test('isDisplayableWallet rejects null', () => {
  assert.equal(isDisplayableWallet(null), false);
});

test('isDisplayableWallet rejects undefined', () => {
  assert.equal(isDisplayableWallet(undefined), false);
});

test('isDisplayableWallet rejects empty string', () => {
  assert.equal(isDisplayableWallet(''), false);
});

test('isDisplayableWallet rejects non-string types', () => {
  assert.equal(isDisplayableWallet(123), false);
  assert.equal(isDisplayableWallet(true), false);
  assert.equal(isDisplayableWallet({}), false);
  assert.equal(isDisplayableWallet([]), false);
});

// ─── truncateWalletAddress ───────────────────────────────────────────────────

test('truncateWalletAddress truncates a 56-char Stellar key with default lengths', () => {
  const key = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  assert.equal(truncateWalletAddress(key), 'GBBD47...FLA5');
});

test('truncateWalletAddress respects custom prefix and suffix lengths', () => {
  const key = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  assert.equal(truncateWalletAddress(key, 4, 4), 'GBBD...FLA5');
  assert.equal(truncateWalletAddress(key, 8, 6), 'GBBD47IF...LLFLA5');
});

test('truncateWalletAddress returns full string when shorter than truncation window', () => {
  assert.equal(truncateWalletAddress('GABCDE', 6, 4), 'GABCDE');
  assert.equal(truncateWalletAddress('SHORT', 6, 4), 'SHORT');
});

test('truncateWalletAddress returns full string when at min length boundary', () => {
  const atBoundary = 'GABCDEFGHI';
  assert.equal(truncateWalletAddress(atBoundary, 6, 4), 'GABCDEFGHI');
});

test('truncateWalletAddress truncates string one char above min length', () => {
  const above = 'GABCDEFGHIJ';
  assert.equal(truncateWalletAddress(above, 6, 4), 'GABCDE...GHIJ');
});

test('truncateWalletAddress returns empty string for null', () => {
  assert.equal(truncateWalletAddress(null), '');
});

test('truncateWalletAddress returns empty string for undefined', () => {
  assert.equal(truncateWalletAddress(undefined), '');
});

test('truncateWalletAddress returns empty string for empty string', () => {
  assert.equal(truncateWalletAddress(''), '');
});

test('truncateWalletAddress returns empty string for non-string types', () => {
  assert.equal(truncateWalletAddress(12345), '');
  assert.equal(truncateWalletAddress(true), '');
  assert.equal(truncateWalletAddress({}), '');
});

// ─── safeDisconnect ──────────────────────────────────────────────────────────

test('safeDisconnect calls disconnectStore and onDisconnect', () => {
  let storeCalled = false;
  let callbackCalled = false;
  const result = safeDisconnect(
    () => { storeCalled = true; },
    () => { callbackCalled = true; }
  );
  assert.equal(result.ok, true);
  assert.equal(storeCalled, true);
  assert.equal(callbackCalled, true);
});

test('safeDisconnect works with no onDisconnect callback', () => {
  let storeCalled = false;
  const result = safeDisconnect(() => { storeCalled = true; }, undefined);
  assert.equal(result.ok, true);
  assert.equal(storeCalled, true);
});

test('safeDisconnect works with null onDisconnect callback', () => {
  let storeCalled = false;
  const result = safeDisconnect(() => { storeCalled = true; }, null);
  assert.equal(result.ok, true);
  assert.equal(storeCalled, true);
});

test('safeDisconnect catches and reports callback errors without throwing', () => {
  let storeCalled = false;
  const result = safeDisconnect(
    () => { storeCalled = true; },
    () => { throw new Error('callback crashed'); }
  );
  assert.equal(storeCalled, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'callback crashed');
});

test('safeDisconnect always calls disconnectStore even if callback will fail', () => {
  let storeCalled = false;
  safeDisconnect(
    () => { storeCalled = true; },
    () => { throw new Error('oops'); }
  );
  assert.equal(storeCalled, true);
});

test('safeDisconnect handles non-Error throw from callback', () => {
  const result = safeDisconnect(
    () => {},
    () => { throw 'string error'; }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Disconnect callback failed');
});
