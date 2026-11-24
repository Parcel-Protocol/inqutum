const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InvoiceFormCode,
  INVOICE_FORM_RECOVERY,
  classifyInvoiceFormFailure,
  resolveInvoiceFormOutcome,
} = require('../lib/invoice-form-validation');

const valid = {
  amount: ' 125.50 ',
  sellerEmail: ' seller@example.com ',
  customerEmail: 'customer@domain.org',
};

test('success path accepts a trimmed invoice form when the dependency is healthy', () => {
  const outcome = resolveInvoiceFormOutcome(valid);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, InvoiceFormCode.OK);
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.amount, '125.50');
  assert.equal(outcome.sellerEmail, 'seller@example.com');
  assert.equal(outcome.customerEmail, 'customer@domain.org');
});

test('success path allows omitted optional emails', () => {
  const outcome = resolveInvoiceFormOutcome({ amount: 10 });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.amount, '10');
  assert.equal(outcome.sellerEmail, '');
  assert.equal(outcome.customerEmail, '');
});

test('validation path rejects a bad amount and does not offer a retry', () => {
  for (const amount of ['', '0', '-1', 'abc', '10.12345678']) {
    const outcome = resolveInvoiceFormOutcome({ ...valid, amount });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, InvoiceFormCode.VALIDATION_FAILED);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.degraded, false);
    assert.equal(outcome.firstInvalid, 'amount');
    assert.equal(outcome.message, outcome.errors.amount);
    assert.equal(outcome.recoveryAction, INVOICE_FORM_RECOVERY.VALIDATION_FAILED);
  }
});

test('validation path focuses the first invalid email and ignores a down dependency', () => {
  const outcome = resolveInvoiceFormOutcome(
    { ...valid, sellerEmail: 'nope', customerEmail: 'a@b' },
    { degraded: true }
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, InvoiceFormCode.VALIDATION_FAILED);
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.firstInvalid, 'sellerEmail');
  assert.ok(outcome.errors.customerEmail);
});

test('degraded-dependency path does not claim a valid invoice was saved', () => {
  const dependencies = [
    { degraded: true },
    { available: false },
    { status: 'degraded' },
    { code: InvoiceFormCode.API_UNREACHABLE },
    { name: 'ApiUnavailableError' },
    'unavailable',
  ];

  for (const dependency of dependencies) {
    const outcome = resolveInvoiceFormOutcome(valid, dependency);
    assert.equal(outcome.ok, false, String(dependency));
    assert.equal(outcome.code, InvoiceFormCode.API_UNREACHABLE);
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.degraded, true);
    assert.deepEqual(outcome.errors, {});
    assert.equal(outcome.firstInvalid, null);
    assert.equal(outcome.message, 'Quittance API is unreachable. Check your connection and try again.');
    assert.equal(outcome.recoveryAction, INVOICE_FORM_RECOVERY.API_UNREACHABLE);
  }
});

test('a healthy dependency object still succeeds', () => {
  const outcome = resolveInvoiceFormOutcome(valid, { status: 'operational', available: true });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.degraded, false);
});

test('retry path classifies an unreachable API as degraded and retryable', () => {
  const error = Object.assign(new Error('Quittance API is unreachable.'), {
    name: 'ApiUnavailableError',
    code: InvoiceFormCode.API_UNREACHABLE,
  });
  const classified = classifyInvoiceFormFailure(error);

  assert.equal(classified.degraded, true);
  assert.equal(classified.retryable, true);
  assert.equal(classified.code, InvoiceFormCode.API_UNREACHABLE);
  assert.equal(classified.message, 'Quittance API is unreachable.');
  assert.equal(classified.recoveryAction, INVOICE_FORM_RECOVERY.API_UNREACHABLE);
});

test('retry path keeps an explicitly retryable request retryable without marking it degraded', () => {
  const classified = classifyInvoiceFormFailure(
    Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED', retryable: true })
  );

  assert.equal(classified.degraded, false);
  assert.equal(classified.retryable, true);
  assert.equal(classified.code, 'RATE_LIMITED');
  assert.equal(classified.recoveryAction, INVOICE_FORM_RECOVERY.API_REQUEST_FAILED);
});

test('validation failures from the server are not retryable', () => {
  const classified = classifyInvoiceFormFailure(
    Object.assign(new Error('Invoice validation failed'), {
      code: InvoiceFormCode.VALIDATION_FAILED,
      retryable: false,
    })
  );

  assert.equal(classified.degraded, false);
  assert.equal(classified.retryable, false);
  assert.equal(classified.code, InvoiceFormCode.VALIDATION_FAILED);
  assert.equal(classified.recoveryAction, INVOICE_FORM_RECOVERY.VALIDATION_FAILED);
});

test('unknown failures fall back to a stable non-retryable code and message', () => {
  for (const error of [undefined, null, {}, 'boom']) {
    const classified = classifyInvoiceFormFailure(error, 'Failed to create invoice');
    assert.equal(classified.code, InvoiceFormCode.API_REQUEST_FAILED);
    assert.equal(classified.degraded, false);
    assert.equal(classified.retryable, false);
    assert.equal(classified.message, 'Failed to create invoice');
  }
});
