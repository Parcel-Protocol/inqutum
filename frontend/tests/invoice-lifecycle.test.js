const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyExpiryLifecycle,
  applyExpiryStatus,
  effectiveInvoiceStatus,
  hasInvoiceExpired,
  isActionableInvoice,
  canCancelInvoice,
  canPayInvoice,
  allowedTransitions,
  canTransition,
  isTerminalStatus,
  INVOICE_STATUSES,
} = require('../lib/invoice-lifecycle');
const shared = require('../../shared/invoice-lifecycle.ts');

const NOW = '2026-08-30T12:00:00.000Z';

test('a pending invoice expires at its exact timestamp', () => {
  const invoice = { status: 'PENDING', expiresAt: NOW };
  assert.equal(hasInvoiceExpired(invoice, NOW), true);
  assert.equal(effectiveInvoiceStatus(invoice, NOW), 'EXPIRED');
  assert.equal(isActionableInvoice(invoice, NOW), false);
});

test('future pending invoices remain actionable and paid invoices never regress', () => {
  const future = { status: 'PENDING', expiresAt: '2026-08-31T12:00:00.000Z' };
  const paid = { status: 'PAID', expiresAt: '2026-08-29T12:00:00.000Z' };
  assert.equal(isActionableInvoice(future, NOW), true);
  assert.equal(effectiveInvoiceStatus(paid, NOW), 'PAID');
});

test('lifecycle projection does not mutate stale API objects', () => {
  const stale = { id: 'old', status: 'PENDING', expiresAt: '2026-08-29T12:00:00.000Z' };
  const projected = applyExpiryStatus(stale, NOW);
  assert.equal(projected.status, 'EXPIRED');
  assert.equal(stale.status, 'PENDING');
  assert.deepEqual(applyExpiryLifecycle([stale], NOW), [projected]);
});

test('missing or malformed expiry never invents an expiration', () => {
  assert.equal(hasInvoiceExpired({ status: 'PENDING' }, NOW), false);
  assert.equal(hasInvoiceExpired({ status: 'PENDING', expiresAt: 'bad' }, NOW), false);
  assert.equal(hasInvoiceExpired(null, NOW), false);
});

test('the UI reads the same lifecycle table the backend stores enforce', () => {
  assert.deepEqual([...INVOICE_STATUSES], [...shared.INVOICE_STATUSES]);
  for (const status of shared.INVOICE_STATUSES) {
    assert.deepEqual(allowedTransitions(status), shared.allowedTransitions(status));
    assert.equal(isTerminalStatus(status), shared.isTerminalStatus(status));
  }
  assert.equal(canTransition('PAID', 'CANCELLED'), false);
});

test('only an unexpired PENDING invoice can be cancelled', () => {
  const future = '2026-08-31T12:00:00.000Z';
  assert.equal(canCancelInvoice({ status: 'PENDING', expiresAt: future }, NOW), true);
  assert.equal(canCancelInvoice({ status: 'PENDING', expiresAt: NOW }, NOW), false, 'expired by the clock');
  assert.equal(canCancelInvoice({ status: 'PAID', expiresAt: future }, NOW), false);
  assert.equal(canCancelInvoice({ status: 'CANCELLED', expiresAt: future }, NOW), false);
  assert.equal(canCancelInvoice({ status: 'EXPIRED', expiresAt: future }, NOW), false);
  assert.equal(canCancelInvoice(null, NOW), false);
});

test('a cancelled invoice is never offered for payment even though the server can settle it late', () => {
  const future = '2026-08-31T12:00:00.000Z';
  assert.equal(canTransition('CANCELLED', 'PAID'), true, 'model allows late settlement');
  assert.equal(canPayInvoice({ status: 'CANCELLED', expiresAt: future }, NOW), false);
  assert.equal(canPayInvoice({ status: 'PENDING', expiresAt: future }, NOW), true);
  assert.equal(canPayInvoice({ status: 'PENDING', expiresAt: future, paymentTxHash: 'abc' }, NOW), false);
  assert.equal(canPayInvoice({ status: 'PENDING', expiresAt: NOW }, NOW), false);
});
