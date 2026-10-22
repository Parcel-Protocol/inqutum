const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPaymentProofAvailable,
  canExportPaymentProof,
} = require('../lib/payment-proof-policy');
const {
  PRINT_DOCUMENT_CSP,
  buildMailtoUrl,
  csvCell,
  escapeHtml,
} = require('../lib/safe-content');

test('Issue #148: export contract enforces payment proof policy', () => {
  // Only PAID invoices can be exported as payment proofs
  assert.equal(canExportPaymentProof({ status: 'PAID' }), true);
  assert.equal(canExportPaymentProof({ status: 'PENDING' }), false);
  assert.equal(canExportPaymentProof({ status: 'EXPIRED' }), false);
  assert.equal(canExportPaymentProof(null), false);
  assert.equal(canExportPaymentProof(undefined), false);

  // Assertion throws informative error for unpayable exports
  assert.doesNotThrow(() => assertPaymentProofAvailable({ status: 'PAID' }));
  assert.throws(
    () => assertPaymentProofAvailable({ status: 'PENDING' }),
    /Payment proof is available only after the invoice is paid/
  );
  assert.throws(
    () => assertPaymentProofAvailable(null),
    /Payment proof is available only after the invoice is paid/
  );
});

test('Issue #148: CSV export sanitizes formula injection characters', () => {
  const formulaPayloads = [
    '=CMD|"/C calc"!A0',
    '+123456789',
    '-SUM(1+1)',
    '@HYPERLINK("http://evil.com")',
    '\tDDE("cmd")',
    '\rcalc',
  ];

  for (const payload of formulaPayloads) {
    const cell = csvCell(payload);
    // Must be quoted and prefixed with apostrophe to neutralize in Excel/Sheets
    assert.match(cell, /^"'/);
  }
});

test('Issue #148: CSV export handles null, undefined, and numeric cells safely', () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(100.5), '"100.5"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell('regular text'), '"regular text"');
  assert.equal(csvCell('contains "quotes"'), '"contains ""quotes"""');
});

test('Issue #148: HTML export escapes malicious tags and script vectors', () => {
  const xssPayload = '<script>alert("xss")</script>';
  const escaped = escapeHtml(xssPayload);
  assert.equal(escaped.includes('<script>'), false);
  assert.equal(escaped.includes('</script>'), false);
  assert.equal(
    escaped,
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
  );
});

test('Issue #148: printable document enforces restrictive CSP', () => {
  assert.ok(PRINT_DOCUMENT_CSP);
  assert.match(PRINT_DOCUMENT_CSP, /default-src 'none'/);
  assert.match(PRINT_DOCUMENT_CSP, /style-src 'unsafe-inline'/);
});

test('Issue #148: mailto link generation validates recipient and constructs query', () => {
  const validLink = buildMailtoUrl(
    'client@example.com',
    'Invoice #INV123',
    'Here is your invoice link.'
  );
  assert.ok(validLink);
  assert.match(validLink, /^mailto:client@example\.com\?/);
  assert.match(validLink, /subject=Invoice%20%23INV123/);

  // Invalid email rejects link creation
  const invalidLink = buildMailtoUrl('not-an-email', 'Subject', 'Body');
  assert.equal(invalidLink, null);
});

// The proof-rendering regressions for these issues now live in
// `tests/export.test.mjs`, which loads the real module (`lib/export.ts`) with
// Node's TypeScript support. `lib/export.js` was a stale duplicate of that
// module, so this suite only covers the plain CommonJS helpers it re-exports.
