const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BALANCE_ERROR_CODES,
  resolveXlmBalance,
  classifyBalanceError,
  safeBalanceFallback,
  balanceErrorToast,
  executeLoadBalance,
} = require('../lib/wallet-connect-contract');

// ─── resolveXlmBalance ──────────────────────────────────────────────────────

test('resolveXlmBalance extracts XLM balance from Horizon response', () => {
  const balances = [
    { assetCode: 'USDC', balance: '50.0000000' },
    { assetCode: 'XLM', balance: '123.4567890' },
  ];
  assert.equal(resolveXlmBalance(balances), '123.46');
});

test('resolveXlmBalance returns 0.00 when XLM entry is absent', () => {
  assert.equal(resolveXlmBalance([{ assetCode: 'USDC', balance: '10.00' }]), '0.00');
});

test('resolveXlmBalance returns 0.00 for empty array', () => {
  assert.equal(resolveXlmBalance([]), '0.00');
});

test('resolveXlmBalance returns 0.00 for non-array input', () => {
  assert.equal(resolveXlmBalance(null), '0.00');
  assert.equal(resolveXlmBalance(undefined), '0.00');
  assert.equal(resolveXlmBalance('not-array'), '0.00');
});

test('resolveXlmBalance handles malformed balance strings', () => {
  assert.equal(resolveXlmBalance([{ assetCode: 'XLM', balance: 'bad' }]), '0.00');
  assert.equal(resolveXlmBalance([{ assetCode: 'XLM', balance: '' }]), '0.00');
});

test('resolveXlmBalance handles null entries in array', () => {
  assert.equal(resolveXlmBalance([null, { assetCode: 'XLM', balance: '10.00' }]), '10.00');
});

test('resolveXlmBalance handles XLM entry with non-string balance', () => {
  assert.equal(resolveXlmBalance([{ assetCode: 'XLM', balance: 100 }]), '0.00');
});

test('resolveXlmBalance returns 0.00 for negative balance strings', () => {
  assert.equal(resolveXlmBalance([{ assetCode: 'XLM', balance: '-5.00' }]), '0.00');
});

// ─── classifyBalanceError ────────────────────────────────────────────────────

test('classifyBalanceError identifies 404 Not Found as UNFUNDED', () => {
  const err404 = { message: 'Not Found', response: { status: 404 } };
  assert.equal(classifyBalanceError(err404), BALANCE_ERROR_CODES.UNFUNDED);
});

test('classifyBalanceError identifies message-only Not Found as UNFUNDED', () => {
  const err = { message: 'Account Not Found on network' };
  assert.equal(classifyBalanceError(err), BALANCE_ERROR_CODES.UNFUNDED);
});

test('classifyBalanceError identifies status-only 404 as UNFUNDED', () => {
  const err = { response: { status: 404 } };
  assert.equal(classifyBalanceError(err), BALANCE_ERROR_CODES.UNFUNDED);
});

test('classifyBalanceError classifies network errors as DEGRADED', () => {
  const err = { code: 'ERR_NETWORK', message: 'Network Error' };
  assert.equal(classifyBalanceError(err), BALANCE_ERROR_CODES.DEGRADED);
});

test('classifyBalanceError classifies timeout as DEGRADED', () => {
  const err = { code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' };
  assert.equal(classifyBalanceError(err), BALANCE_ERROR_CODES.DEGRADED);
});

test('classifyBalanceError classifies null/undefined error as DEGRADED', () => {
  assert.equal(classifyBalanceError(null), BALANCE_ERROR_CODES.DEGRADED);
  assert.equal(classifyBalanceError(undefined), BALANCE_ERROR_CODES.DEGRADED);
});

test('classifyBalanceError classifies 500 server error as DEGRADED', () => {
  const err = { response: { status: 500 }, message: 'Internal Server Error' };
  assert.equal(classifyBalanceError(err), BALANCE_ERROR_CODES.DEGRADED);
});

// ─── safeBalanceFallback ─────────────────────────────────────────────────────

test('safeBalanceFallback always returns store-valid numeric string', () => {
  assert.equal(safeBalanceFallback(BALANCE_ERROR_CODES.UNFUNDED), '0');
  assert.equal(safeBalanceFallback(BALANCE_ERROR_CODES.DEGRADED), '0');
  assert.equal(Number(safeBalanceFallback('UNFUNDED')), 0);
  assert.equal(isNaN(Number(safeBalanceFallback('DEGRADED'))), false);
});

// ─── balanceErrorToast ───────────────────────────────────────────────────────

test('balanceErrorToast returns funding message for UNFUNDED', () => {
  const result = balanceErrorToast(BALANCE_ERROR_CODES.UNFUNDED);
  assert.equal(result.type, 'warning');
  assert.equal(result.message, 'Account needs funding');
  assert.equal(result.description, undefined);
});

test('balanceErrorToast returns degraded message with network description', () => {
  const describer = (err) => `Horizon down: ${err.code}`;
  const result = balanceErrorToast(BALANCE_ERROR_CODES.DEGRADED, describer, { code: 'ERR_NETWORK' });
  assert.equal(result.type, 'warning');
  assert.equal(result.message, 'Wallet connected; balance unavailable');
  assert.equal(result.description, 'Horizon down: ERR_NETWORK');
});

test('balanceErrorToast uses fallback description when describer is missing', () => {
  const result = balanceErrorToast(BALANCE_ERROR_CODES.DEGRADED, undefined, {});
  assert.equal(result.description, 'Stellar network request failed.');
});

// ─── executeLoadBalance ──────────────────────────────────────────────────────

test('executeLoadBalance sets wallet with resolved balance on success', async () => {
  let walletCall = null;
  const deps = {
    getAccountBalance: async () => [{ assetCode: 'XLM', balance: '250.5000000' }],
    setWallet: (key, balance) => { walletCall = { key, balance }; },
  };
  const result = await executeLoadBalance(deps, 'GTEST');
  assert.equal(result.ok, true);
  assert.equal(result.balance, '250.50');
  assert.equal(walletCall.key, 'GTEST');
  assert.equal(walletCall.balance, '250.50');
});

test('executeLoadBalance handles unfunded account with safe fallback', async () => {
  let walletCall = null;
  let toastCall = null;
  const deps = {
    getAccountBalance: async () => { throw { message: 'Not Found', response: { status: 404 } }; },
    setWallet: (key, balance) => { walletCall = { key, balance }; },
    toast: { warning: (msg, opts) => { toastCall = { msg, opts }; } },
  };
  const result = await executeLoadBalance(deps, 'GTEST');
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UNFUNDED');
  assert.equal(walletCall.balance, '0');
  assert.equal(toastCall.msg, 'Account needs funding');
});

test('executeLoadBalance handles Horizon degradation with safe fallback', async () => {
  let walletCall = null;
  let toastCall = null;
  const deps = {
    getAccountBalance: async () => { throw { code: 'ERR_NETWORK', message: 'Network Error' }; },
    setWallet: (key, balance) => { walletCall = { key, balance }; },
    describeNetworkError: () => 'Horizon unreachable',
    toast: { warning: (msg, opts) => { toastCall = { msg, opts }; } },
  };
  const result = await executeLoadBalance(deps, 'GTEST');
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DEGRADED');
  assert.equal(walletCall.balance, '0');
  assert.equal(toastCall.msg, 'Wallet connected; balance unavailable');
  assert.equal(toastCall.opts.description, 'Horizon unreachable');
});

test('executeLoadBalance still connects wallet identity even when balance fetch fails', async () => {
  let walletCall = null;
  const deps = {
    getAccountBalance: async () => { throw new Error('timeout'); },
    setWallet: (key, balance) => { walletCall = { key, balance }; },
    toast: { warning: () => {} },
  };
  await executeLoadBalance(deps, 'GFOO');
  assert.equal(walletCall.key, 'GFOO');
  assert.equal(walletCall.balance, '0');
});
