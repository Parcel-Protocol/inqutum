const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROOF_ERRORS,
  validateProofDownload,
  validateProofEmail,
  classifyProofError,
  executeProofDownload,
  executeProofEmail,
} = require('../lib/pay-proof-panel-contract');

const PAID_WITH_EMAIL = { status: 'PAID', customerEmail: 'buyer@example.com', id: 'inv-1' };
const PAID_NO_EMAIL   = { status: 'PAID', customerEmail: null };
const PENDING         = { status: 'PENDING', customerEmail: 'buyer@example.com' };
const EXPIRED         = { status: 'EXPIRED', customerEmail: 'buyer@example.com' };

// ---------------------------------------------------------------- validateProofDownload

test('download validation accepts paid invoice', () => {
  assert.deepEqual(validateProofDownload(PAID_WITH_EMAIL), { ok: true });
});

test('download validation rejects pending invoice', () => {
  const r = validateProofDownload(PENDING);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNPAID');
  assert.equal(r.error, PROOF_ERRORS.UNPAID);
});

test('download validation rejects expired invoice', () => {
  const r = validateProofDownload(EXPIRED);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNPAID');
});

test('download validation rejects null invoice', () => {
  const r = validateProofDownload(null);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- validateProofEmail

test('email validation accepts paid invoice with customer email', () => {
  assert.deepEqual(validateProofEmail(PAID_WITH_EMAIL), { ok: true });
});

test('email validation rejects paid invoice without customer email', () => {
  const r = validateProofEmail(PAID_NO_EMAIL);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_EMAIL');
  assert.equal(r.error, PROOF_ERRORS.NO_EMAIL);
});

test('email validation rejects pending invoice even with email', () => {
  const r = validateProofEmail(PENDING);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNPAID');
});

// ---------------------------------------------------------------- classifyProofError

test('classifyProofError returns message from Error instance', () => {
  const err = new Error('PDF generation failed');
  assert.equal(classifyProofError(err, 'download'), 'PDF generation failed');
});

test('classifyProofError falls back to default download message on null', () => {
  assert.equal(classifyProofError(null, 'download'), PROOF_ERRORS.DOWNLOAD_FAILED);
});

test('classifyProofError falls back to default email message on null', () => {
  assert.equal(classifyProofError(null, 'email'), PROOF_ERRORS.EMAIL_FAILED);
});

// ---------------------------------------------------------------- executeProofDownload

test('executeProofDownload succeeds for paid invoice', async () => {
  let called = false;
  const r = await executeProofDownload(
    { onDownload: () => { called = true; } },
    PAID_WITH_EMAIL
  );
  assert.equal(r.success, true);
  assert.equal(called, true);
});

test('executeProofDownload fails and calls onError for unpaid invoice', async () => {
  let errorReceived = null;
  const r = await executeProofDownload(
    { onDownload: () => {}, onError: (e) => { errorReceived = e; } },
    PENDING
  );
  assert.equal(r.success, false);
  assert.ok(errorReceived instanceof Error);
  assert.ok(errorReceived.message.includes('paid'));
});

test('executeProofDownload catches synchronous throw from onDownload', async () => {
  let errorReceived = null;
  const r = await executeProofDownload(
    {
      onDownload: () => { throw new Error('Disk full'); },
      onError: (e) => { errorReceived = e; },
    },
    PAID_WITH_EMAIL
  );
  assert.equal(r.success, false);
  assert.equal(r.error, 'Disk full');
  assert.ok(errorReceived instanceof Error);
});

test('executeProofDownload catches async rejection from onDownload', async () => {
  const r = await executeProofDownload(
    { onDownload: async () => { throw new Error('Network error'); } },
    PAID_WITH_EMAIL
  );
  assert.equal(r.success, false);
  assert.equal(r.error, 'Network error');
});

// ---------------------------------------------------------------- executeProofEmail

test('executeProofEmail succeeds for paid invoice with email', async () => {
  let called = false;
  const r = await executeProofEmail(
    { onEmail: () => { called = true; } },
    PAID_WITH_EMAIL
  );
  assert.equal(r.success, true);
  assert.equal(called, true);
});

test('executeProofEmail fails and calls onError when no customer email', async () => {
  let errorReceived = null;
  const r = await executeProofEmail(
    { onEmail: () => {}, onError: (e) => { errorReceived = e; } },
    PAID_NO_EMAIL
  );
  assert.equal(r.success, false);
  assert.equal(r.error, PROOF_ERRORS.NO_EMAIL);
  assert.ok(errorReceived instanceof Error);
});

test('executeProofEmail degraded: catches email service failure', async () => {
  let errorReceived = null;
  const r = await executeProofEmail(
    {
      onEmail: async () => { throw new Error('SMTP connection refused'); },
      onError: (e) => { errorReceived = e; },
    },
    PAID_WITH_EMAIL
  );
  assert.equal(r.success, false);
  assert.equal(r.error, 'SMTP connection refused');
  assert.ok(errorReceived instanceof Error);
});

test('executeProofEmail retry path: second call succeeds after transient failure', async () => {
  let attempts = 0;
  const flaky = () => {
    attempts++;
    if (attempts === 1) throw new Error('transient error');
  };

  const first = await executeProofEmail({ onEmail: flaky }, PAID_WITH_EMAIL);
  assert.equal(first.success, false);

  const second = await executeProofEmail({ onEmail: flaky }, PAID_WITH_EMAIL);
  assert.equal(second.success, true);
  assert.equal(attempts, 2);
});

// ---------------------------------------------------------------- Additional edge cases (issue #164)

test('validateProofDownload rejects undefined invoice', () => {
  const r = validateProofDownload(undefined);
  assert.equal(r.ok, false);
});

test('validateProofEmail rejects empty string customerEmail', () => {
  const r = validateProofEmail({ status: 'PAID', customerEmail: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_EMAIL');
});

test('PROOF_ERRORS is frozen', () => {
  assert.throws(() => {
    'use strict';
    PROOF_ERRORS.NO_EMAIL = 'mutated';
  });
});

test('classifyProofError handles non-Error objects with a message property', () => {
  const result = classifyProofError({ message: 'rate limited' }, 'email');
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});

test('executeProofDownload does not call onDownload for cancelled invoice', async () => {
  let downloadCalled = false;
  const r = await executeProofDownload(
    { onDownload: () => { downloadCalled = true; } },
    { status: 'CANCELLED', customerEmail: 'buyer@example.com' }
  );
  assert.equal(r.success, false);
  assert.equal(downloadCalled, false);
});
