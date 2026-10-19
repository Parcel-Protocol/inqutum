const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Stellar network contract tests (#179).
 * Validates the pure network/URL logic that stellar.ts relies on.
 */

const NETWORKS = {
  TESTNET: 'Test SDF Network ; September 2015',
  PUBLIC: 'Public Global Stellar Network ; September 2015',
};

function isWrongNetwork(current, expected = 'TESTNET') {
  if (!current) return false;
  const cur = current.trim();
  const exp = expected.toUpperCase();
  const expectedPassphrase = exp === 'TESTNET' ? NETWORKS.TESTNET : NETWORKS.PUBLIC;
  if (cur.toUpperCase() === exp || cur === expectedPassphrase) return false;
  if (exp === 'TESTNET' && cur.toLowerCase().includes('test sdf network')) return false;
  if (exp === 'PUBLIC' && cur.toLowerCase().includes('public global stellar network')) return false;
  return true;
}

test('network matching accepts exact names and passphrases', () => {
  assert.equal(isWrongNetwork('TESTNET', 'TESTNET'), false);
  assert.equal(isWrongNetwork('PUBLIC', 'PUBLIC'), false);
  assert.equal(isWrongNetwork(NETWORKS.TESTNET, 'TESTNET'), false);
  assert.equal(isWrongNetwork(NETWORKS.PUBLIC, 'PUBLIC'), false);
});

test('network matching is case-insensitive', () => {
  assert.equal(isWrongNetwork('testnet', 'TESTNET'), false);
  assert.equal(isWrongNetwork('Testnet', 'TESTNET'), false);
  assert.equal(isWrongNetwork('public', 'PUBLIC'), false);
});

test('network matching detects mismatches', () => {
  assert.equal(isWrongNetwork('PUBLIC', 'TESTNET'), true);
  assert.equal(isWrongNetwork('TESTNET', 'PUBLIC'), true);
  assert.equal(isWrongNetwork(NETWORKS.PUBLIC, 'TESTNET'), true);
});

test('network matching handles null and empty values gracefully', () => {
  assert.equal(isWrongNetwork(null, 'TESTNET'), false);
  assert.equal(isWrongNetwork(undefined, 'TESTNET'), false);
  assert.equal(isWrongNetwork('', 'TESTNET'), false);
});

function buildHorizonUrl(network) {
  return network === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

test('horizon URL defaults to testnet for TESTNET, public otherwise', () => {
  assert.equal(buildHorizonUrl('TESTNET'), 'https://horizon-testnet.stellar.org');
  assert.equal(buildHorizonUrl('PUBLIC'), 'https://horizon.stellar.org');
  assert.equal(buildHorizonUrl(null), 'https://horizon.stellar.org');
  assert.equal(buildHorizonUrl(undefined), 'https://horizon.stellar.org');
});

function describeStellarNetworkError(error) {
  if (error?.message?.includes('Not Found') || error?.response?.status === 404) {
    return 'Account needs funding on the selected Stellar network.';
  }
  if (!error?.response || ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) {
    return 'Stellar Horizon is temporarily unreachable. Your wallet can stay connected; retry shortly.';
  }
  return error?.message || 'Stellar network request failed.';
}

test('404 errors produce the funding message', () => {
  assert.match(describeStellarNetworkError({ response: { status: 404 } }), /funding/);
  assert.match(describeStellarNetworkError({ message: 'Not Found' }), /funding/);
});

test('network errors produce the retry message', () => {
  assert.match(describeStellarNetworkError({ code: 'ERR_NETWORK' }), /retry shortly/);
  assert.match(describeStellarNetworkError({ code: 'ETIMEDOUT' }), /retry shortly/);
  assert.match(describeStellarNetworkError({}), /retry shortly/);
});

test('server errors fall through to message or generic fallback', () => {
  assert.equal(describeStellarNetworkError({ response: { status: 500 }, message: 'Server error' }), 'Server error');
  assert.equal(describeStellarNetworkError({ response: { status: 500 } }), 'Stellar network request failed.');
});

const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

test('public key pattern accepts valid Stellar keys', () => {
  assert.ok(STELLAR_PUBLIC_KEY.test('G' + 'A'.repeat(55)));
  assert.ok(STELLAR_PUBLIC_KEY.test('G' + 'B'.repeat(55)));
});

test('public key pattern rejects invalid keys', () => {
  assert.ok(!STELLAR_PUBLIC_KEY.test(''));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + 'A'.repeat(54)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + 'A'.repeat(56)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('H' + 'A'.repeat(55)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + 'a'.repeat(55)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + '0'.repeat(55)));
});
