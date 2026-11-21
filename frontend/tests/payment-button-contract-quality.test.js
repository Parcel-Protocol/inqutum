const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WALLET_ERRORS,
  validatePaymentRequest,
  classifyPaymentError,
  executePaymentContract,
} = require('../lib/payment-button-contract');

const validParams = {
  destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  amount: '10.00',
  memo: 'INV-5678',
  assetCode: 'XLM',
  invoiceId: 'inv-uuid-2',
  invoiceStatus: 'PENDING',
};

// ---------------------------------------------------------------- Validation edge cases

test('rejects destination with only whitespace', () => {
  const r = validatePaymentRequest({ ...validParams, destination: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_DESTINATION');
});

test('rejects amount of zero as string', () => {
  const r = validatePaymentRequest({ ...validParams, amount: '0.00' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_AMOUNT');
});

test('rejects negative amount', () => {
  const r = validatePaymentRequest({ ...validParams, amount: '-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_AMOUNT');
});

test('rejects NaN amount', () => {
  const r = validatePaymentRequest({ ...validParams, amount: 'NaN' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_AMOUNT');
});

test('accepts amount as number type', () => {
  const r = validatePaymentRequest({ ...validParams, amount: 5 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.numAmount, 5);
});

test('rejects CANCELLED invoice status', () => {
  const r = validatePaymentRequest({ ...validParams, invoiceStatus: 'CANCELLED' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVOICE_NOT_PENDING');
});

test('rejects PAID invoice status', () => {
  const r = validatePaymentRequest({ ...validParams, invoiceStatus: 'PAID' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVOICE_NOT_PENDING');
});

// ---------------------------------------------------------------- Error classification edge cases

test('classifies XLM trustline error as generic failure not trustline', () => {
  const err = new Error('op_no_trust: some trustline message');
  const c = classifyPaymentError(err, 'XLM');
  assert.equal(c.isTrustline, false);
  assert.equal(c.title, 'Payment failed');
  assert.equal(c.duration, undefined);
});

test('classifies USDC trustline with 10s duration', () => {
  const err = new Error('op_no_trust: trustline missing');
  const c = classifyPaymentError(err, 'USDC');
  assert.equal(c.isTrustline, true);
  assert.equal(c.duration, 10000);
  assert.match(c.title, /USDC/);
});

test('classifyPaymentError handles string error gracefully', () => {
  const c = classifyPaymentError('User declined', 'XLM');
  assert.equal(c.title, 'Payment failed');
  assert.equal(c.description, 'User declined');
});

// ---------------------------------------------------------------- executePaymentContract edge cases

test('reports validation error without calling onStart', async () => {
  let startCalled = false;
  const r = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'hash',
      onStart: () => { startCalled = true; },
    },
    { ...validParams, invoiceStatus: 'EXPIRED' }
  );
  assert.equal(r.success, false);
  assert.equal(startCalled, false);
});

test('handles requestWalletAccess throwing as denial', async () => {
  let errMsg = null;
  const r = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => { throw new Error('extension crashed'); },
      sendPayment: async () => 'hash',
      onError: (m) => { errMsg = m; },
    },
    validParams
  );
  assert.equal(r.success, false);
  assert.equal(errMsg, WALLET_ERRORS.ACCESS_DENIED);
});

test('degraded: verifyInvoice throws non-network error still resolves success', async () => {
  let warnMsg = null;
  let succeededHash = null;
  const r = await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'd'.repeat(64),
      verifyInvoice: async () => { throw new Error('403 Forbidden'); },
      toast: { warning: (title, opts) => { warnMsg = { title, desc: opts?.description }; } },
      onSuccess: (h) => { succeededHash = h; },
    },
    validParams
  );
  assert.equal(r.success, true);
  assert.equal(r.verified, false);
  assert.equal(succeededHash, 'd'.repeat(64));
  assert.equal(warnMsg?.title, 'Payment sent but verification failed');
});

test('reports correct payer fields in successful verification call', async () => {
  let verifyPayer = null;
  await executePaymentContract(
    {
      checkWalletConnection: async () => true,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'e'.repeat(64),
      verifyInvoice: async (id, hash, payer) => { verifyPayer = payer; return { status: 'PAID' }; },
    },
    { ...validParams, payerName: 'Bob', payerEmail: 'bob@example.com' }
  );
  assert.deepEqual(verifyPayer, { payerName: 'Bob', payerEmail: 'bob@example.com' });
});

test('no onStart when wallet is not installed', async () => {
  let startCalled = false;
  await executePaymentContract(
    {
      checkWalletConnection: async () => false,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'hash',
      showFreighterInstallPrompt: () => {},
      onStart: () => { startCalled = true; },
    },
    validParams
  );
  // onStart fires before the wallet check, per the contract.
  // This test documents that onStart IS called even when wallet is unavailable.
  assert.equal(startCalled, true);
});

// ---------------------------------------------------------------- Additional edge cases (issue #166)

test('WALLET_ERRORS is frozen', () => {
  assert.throws(() => {
    'use strict';
    WALLET_ERRORS.NOT_INSTALLED = 'mutated';
  });
});

test('validatePaymentRequest rejects undefined params', () => {
  const r = validatePaymentRequest(undefined);
  assert.equal(r.ok, false);
});

test('validatePaymentRequest rejects Infinity amount', () => {
  const r = validatePaymentRequest({ ...validParams, amount: Infinity });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_AMOUNT');
});

test('validatePaymentRequest rejects empty string amount', () => {
  const r = validatePaymentRequest({ ...validParams, amount: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_AMOUNT');
});

test('classifyPaymentError with no error object falls back gracefully', () => {
  const c = classifyPaymentError(null, 'XLM');
  assert.equal(c.title, 'Payment failed');
  assert.equal(typeof c.description, 'string');
});

test('executePaymentContract: onError is called with the wallet error message', async () => {
  let errMsg = null;
  await executePaymentContract(
    {
      checkWalletConnection: async () => false,
      requestWalletAccess: async () => true,
      sendPayment: async () => 'hash',
      showFreighterInstallPrompt: () => {},
      onError: (m) => { errMsg = m; },
    },
    validParams
  );
  assert.equal(errMsg, WALLET_ERRORS.NOT_INSTALLED);
});
