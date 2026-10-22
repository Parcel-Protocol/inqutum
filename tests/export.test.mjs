import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./export-loader.mjs', import.meta.url);

const {
  EXPORT_ERRORS,
  ExportError,
  downloadInvoiceCSV,
  escapeHtml,
  generateInvoiceCSV,
  generateInvoicePDF,
  isExportError,
  openInvoicePDF,
  shareInvoiceByEmail,
  toExportFailure,
} = await import('../frontend/lib/export.ts');

const PAID_INVOICE = {
  id: '12345678-abcd-1234-abcd-1234567890ab',
  amount: 150.75,
  assetCode: 'XLM',
  status: 'PAID',
  createdAt: '2026-01-01T10:00:00.000Z',
  expiresAt: '2026-01-08T10:00:00.000Z',
  paidAt: '2026-01-02T14:30:00.000Z',
  memo: 'MEMO-STABLE-123',
  sellerPublicKey: 'G' + 'A'.repeat(55),
  payerPublicKey: 'G' + 'B'.repeat(55),
  paymentTxHash: 'a'.repeat(64),
  customerName: 'Alice',
  customerEmail: 'client@example.com',
};

test('escapeHtml encodes characters that can create HTML markup or attributes', () => {
  assert.equal(
    escapeHtml(`<script data-value="'">& run()</script>`),
    '&lt;script data-value=&quot;&#039;&quot;&gt;&amp; run()&lt;/script&gt;'
  );
});

test('generateInvoicePDF renders user-supplied proof fields as literal text', () => {
  const invoice = {
    id: 'invoice-<id>',
    amount: 25,
    assetCode: 'XLM<asset>',
    description: 'Description <script>globalThis.compromised = true</script> and <b>bold</b>',
    customerName: 'Customer <customer-name>',
    customerEmail: 'customer+<customer-email>@example.com',
    sellerName: 'Seller <seller-name>',
    sellerEmail: 'seller+<seller-email>@example.com',
    payerName: 'Payer <payer-name>',
    payerEmail: 'payer+<payer-email>@example.com',
    status: 'PAID',
    createdAt: '2026-07-25T10:00:00.000Z',
    expiresAt: '2026-08-25T10:00:00.000Z',
    paidAt: '2026-07-25T11:00:00.000Z',
    memo: 'Memo <memo>',
    sellerPublicKey: 'GSELLER<seller-key>',
    payerPublicKey: 'GPAYER<payer-key>',
    paymentTxHash: 'hash<transaction-hash>',
  };

  const html = generateInvoicePDF(invoice);

  for (const value of [
    invoice.id,
    invoice.assetCode,
    invoice.description,
    invoice.customerName,
    invoice.customerEmail,
    invoice.sellerName,
    invoice.sellerEmail,
    invoice.payerName,
    invoice.payerEmail,
    invoice.memo,
    invoice.sellerPublicKey,
    invoice.payerPublicKey,
    invoice.paymentTxHash,
  ]) {
    assert.ok(html.includes(escapeHtml(value)));
    assert.ok(!html.includes(value));
  }

  assert.ok(html.includes('&lt;script&gt;globalThis.compromised = true&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('Issue #28: deterministic proof regeneration produces identical payment facts across downloads', () => {
  const html1 = generateInvoicePDF(PAID_INVOICE);
  const html2 = generateInvoicePDF(PAID_INVOICE);

  for (const html of [html1, html2]) {
    assert.match(html, /MEMO-STABLE-123/);
    assert.match(html, /150\.75/);
    assert.match(html, /a{64}/);
    assert.match(html, /Verified At/);
    assert.match(html, /Document Downloaded At/);
  }
});

test('Issue #26: tamper-evident payment proof includes live verification endpoint link and tx hash', () => {
  const html = generateInvoicePDF({
    ...PAID_INVOICE,
    memo: 'MEMO-REVERIFY-999',
    paymentTxHash: 'b'.repeat(64),
  });

  assert.match(html, /Verified Transaction Hash/);
  assert.match(html, /b{64}/);
  assert.match(html, /\/pay\/12345678-abcd-1234-abcd-1234567890ab/);
  assert.match(html, /Verified Settlement Record/);
});

// ---------------------------------------------------------------------------
// Issue #173: export boundary contract
//
// The `frontend/lib/export.ts` actions sit between invoice state and the copy a
// user keeps, so each class of behaviour is pinned here: success, validation,
// retry, and degraded dependency.
// ---------------------------------------------------------------------------

test('Issue #173 success: CSV export downloads the escaped file and revokes the object URL', () => {
  const browser = installBrowser();

  try {
    const result = downloadInvoiceCSV(
      [{ ...PAID_INVOICE, description: '=HYPERLINK("http://evil.com")' }],
      'paid-invoices.csv'
    );

    assert.deepEqual(result, { ok: true, code: 'EXPORT_DOWNLOADED' });
    assert.equal(browser.calls.clicked, 1);
    assert.equal(browser.calls.attributes.download, 'paid-invoices.csv');
    assert.equal(browser.calls.attributes.href, 'blob:export');
    assert.equal(browser.anchor.style.visibility, 'hidden');
    assert.deepEqual(browser.calls.revoked, ['blob:export']);

    const [contents] = browser.calls.blobs[0].parts;
    assert.ok(contents.startsWith('\uFEFFInvoice ID,'));
    assert.match(contents, /"'=HYPERLINK\(""http:\/\/evil\.com""\)"/);
  } finally {
    browser.restore();
  }
});

test('Issue #173 success: opening a payment proof writes the document and reports EXPORT_OPENED', () => {
  const browser = installBrowser();

  try {
    const result = openInvoicePDF(PAID_INVOICE);

    assert.deepEqual(result, { ok: true, code: 'EXPORT_OPENED' });
    assert.equal(browser.calls.opened.features, 'width=800,height=600');
    assert.equal(browser.calls.written.length, 1);
    assert.match(browser.calls.written[0], /Verified Settlement Record/);
  } finally {
    browser.restore();
  }
});

test('Issue #173 success: email share of a paid invoice carries verified payment facts', () => {
  const browser = installBrowser();

  try {
    const result = shareInvoiceByEmail(PAID_INVOICE);

    assert.deepEqual(result, { ok: true, code: 'EXPORT_SHARED' });
    assert.match(browser.location.href, /^mailto:client@example\.com\?/);

    const body = decodeURIComponent(browser.location.href);
    assert.match(body, /Verified on Stellar Blockchain/);
    assert.match(body, /Transaction Hash: a{64}/);
  } finally {
    browser.restore();
  }
});

test('Issue #173 recovery: an unpaid invoice shares the payment link instead of dead-ending', () => {
  const browser = installBrowser();

  try {
    const result = shareInvoiceByEmail({
      ...PAID_INVOICE,
      status: 'PENDING',
      paymentTxHash: undefined,
    });

    assert.deepEqual(result, { ok: true, code: 'EXPORT_SHARED' });
    const body = decodeURIComponent(browser.location.href);
    assert.match(body, /Status: PENDING/);
    assert.match(body, /Quittance: https:\/\/quittance\.test\/pay\/12345678-abcd-1234-abcd-1234567890ab/);
    assert.doesNotMatch(body, /Verified on Stellar Blockchain/);
  } finally {
    browser.restore();
  }
});

test('Issue #173 validation: PDF export throws typed INVALID_EXPORT_REQUEST errors', () => {
  const assertInvalidRequest = (invoice, message) => {
    assert.throws(
      () => generateInvoicePDF(invoice),
      (error) => {
        assert.ok(isExportError(error));
        assert.equal(error.code, 'INVALID_EXPORT_REQUEST');
        assert.equal(error.category, 'VALIDATION');
        assert.equal(error.retryable, false);
        assert.match(error.message, message);
        return true;
      }
    );
  };

  assertInvalidRequest(null, /Invoice object is required to generate PDF/);
  assertInvalidRequest({ status: 'PAID' }, /Invoice id and status are required/);
  assertInvalidRequest({ id: '   ', status: 'PAID' }, /Invoice id and status are required/);
  assertInvalidRequest({ id: 'inv-1' }, /Invoice id and status are required/);
});

test('Issue #173 validation: proof export refuses unpaid and expired invoices with stable codes', () => {
  const assertUnavailable = (status, message) => {
    assert.throws(
      () => generateInvoicePDF({ ...PAID_INVOICE, status }),
      (error) => {
        assert.ok(error instanceof ExportError);
        assert.equal(error.code, 'EXPORT_PROOF_UNAVAILABLE');
        assert.equal(error.category, 'LIFECYCLE');
        assert.equal(error.retryable, false);
        assert.match(error.message, message);
        return true;
      }
    );
  };

  assertUnavailable('PENDING', /Payment proof is available only after the invoice is paid/);
  assertUnavailable(
    'EXPIRED',
    /Payment proof is unavailable because this invoice expired unpaid/
  );
});

test('Issue #173 validation: CSV export refuses a missing invoice list instead of writing a header-only file', () => {
  const browser = installBrowser();

  try {
    for (const invoices of [null, undefined, {}, 'invoices']) {
      const result = downloadInvoiceCSV(invoices, 'invoices.csv');

      assert.equal(result.ok, false, String(invoices));
      assert.equal(result.code, 'INVALID_EXPORT_REQUEST');
      assert.equal(result.category, 'VALIDATION');
      assert.equal(result.retryable, false);
      assert.equal(result.message, 'Invoice list is required to export a CSV');
      assert.ok(result.recoveryAction.length > 0);
      assert.ok(result.remediation.length > 0);
    }

    assert.throws(
      () => generateInvoiceCSV(null),
      (error) => isExportError(error) && error.code === 'INVALID_EXPORT_REQUEST'
    );

    // Nothing reached the browser: no download was triggered for invalid input.
    assert.equal(browser.calls.clicked, 0);
    assert.deepEqual(browser.calls.blobs, []);
  } finally {
    browser.restore();
  }
});

test('Issue #173 success: an empty invoice list exports the header row, not a failure', () => {
  const browser = installBrowser();

  try {
    assert.deepEqual(downloadInvoiceCSV([], 'empty.csv'), {
      ok: true,
      code: 'EXPORT_DOWNLOADED',
    });

    const [contents] = browser.calls.blobs[0].parts;
    assert.equal(contents.split('\n').length, 1);
    assert.match(contents, /^\uFEFFInvoice ID,/);
  } finally {
    browser.restore();
  }
});

test('Issue #173 validation: CSV skips corrupted rows but still exports usable records', () => {
  const csv = generateInvoiceCSV([
    null,
    'not-an-invoice',
    { ...PAID_INVOICE, id: 'inv-usable' },
  ]);

  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Invoice ID,/);
  assert.match(lines[1], /inv-usable/);
});

test('Issue #173 hardening: an invoice amount reaching the proof boundary is escaped', () => {
  const html = generateInvoicePDF({
    ...PAID_INVOICE,
    amount: '<img src=x onerror=alert(1)>',
  });

  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'));
});

test('Issue #173 validation: email share returns actionable failures and never throws', () => {
  const browser = installBrowser();

  try {
    assert.deepEqual(shareInvoiceByEmail({ ...PAID_INVOICE, customerEmail: undefined }), {
      ok: false,
      code: 'INVALID_EXPORT_RECIPIENT',
      message: 'Client email is required to send this invoice',
      category: 'VALIDATION',
      retryable: false,
      recoveryAction: EXPORT_ERRORS.INVALID_EXPORT_RECIPIENT.recoveryAction,
      remediation: EXPORT_ERRORS.INVALID_EXPORT_RECIPIENT.remediation,
    });

    const blank = shareInvoiceByEmail({ ...PAID_INVOICE, customerEmail: '   ' });
    assert.equal(blank.code, 'INVALID_EXPORT_RECIPIENT');
    assert.equal(blank.message, 'Client email is required to send this invoice');

    for (const customerEmail of ['not-an-email', 'a@b.io,c@d.io', 'a@b.io?bcc=x@y.io']) {
      const result = shareInvoiceByEmail({ ...PAID_INVOICE, customerEmail });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_EXPORT_RECIPIENT');
      assert.equal(result.message, 'Client email address is not valid');
    }

    const malformed = shareInvoiceByEmail(null);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, 'INVALID_EXPORT_REQUEST');

    assert.equal(browser.location.href, '');
  } finally {
    browser.restore();
  }
});

test('Issue #173 retry: a blocked pop-up is retryable, explained, and restores focus', () => {
  const browser = installBrowser({ popup: null });

  try {
    const result = openInvoicePDF(PAID_INVOICE);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_POPUP_BLOCKED');
    assert.equal(result.retryable, true);
    assert.match(result.recoveryAction, /Allow pop-ups/i);
    assert.ok(result.remediation.length > 0);
    assert.equal(browser.calls.focused, 1);
  } finally {
    browser.restore();
  }
});

test('Issue #173 retry: browser failures return retryable EXPORT_FAILED instead of throwing', () => {
  const openFailed = installBrowser({ openThrows: true });
  try {
    const result = openInvoicePDF(PAID_INVOICE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_FAILED');
    assert.equal(result.retryable, true);
    assert.equal(openFailed.calls.focused, 1);
  } finally {
    openFailed.restore();
  }

  const writeFailed = installBrowser({ writeThrows: true });
  try {
    const result = openInvoicePDF(PAID_INVOICE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_FAILED');
    assert.equal(result.retryable, true);
    assert.equal(writeFailed.calls.closed, 1);
    assert.equal(writeFailed.calls.focused, 1);
  } finally {
    writeFailed.restore();
  }

  const downloadFailed = installBrowser({ createObjectUrlThrows: true });
  try {
    const result = downloadInvoiceCSV([PAID_INVOICE], 'paid.csv');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_FAILED');
    assert.equal(result.retryable, true);
    assert.equal(result.message, 'Failed to generate CSV export.');
    assert.deepEqual(downloadFailed.calls.revoked, []);
  } finally {
    downloadFailed.restore();
  }
});

test('Issue #173 degraded dependency: browser-only exports fail closed with retry guidance', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');

  for (const result of [
    downloadInvoiceCSV([PAID_INVOICE]),
    openInvoicePDF(PAID_INVOICE),
    shareInvoiceByEmail(PAID_INVOICE),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_UNAVAILABLE');
    assert.equal(result.category, 'INTERNAL');
    assert.equal(result.retryable, true);
    assert.match(result.recoveryAction, /browser/i);
    assert.ok(result.remediation.length > 0);
  }

  // Pure generation still works without a browser.
  assert.equal(
    generateInvoiceCSV([]),
    'Invoice ID,Date,Seller Name,Seller Email,Customer Name,Customer Email,Description,Amount,Asset,Status,Payment Date,Payer Name,Payer Email,Expires At,Memo,Transaction Hash'
  );
});

test('Issue #173 contract: codes are stable, documented, and never mutate the invoice', () => {
  const retryableCodes = new Set(['EXPORT_POPUP_BLOCKED', 'EXPORT_UNAVAILABLE', 'EXPORT_FAILED']);
  const categories = new Set(['VALIDATION', 'LIFECYCLE', 'INTERNAL']);

  for (const [code, definition] of Object.entries(EXPORT_ERRORS)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(definition.retryable, retryableCodes.has(code), `${code} retryable flag is stable`);
    assert.ok(definition.message.length > 0, `${code} has a user-safe message`);
    assert.ok(definition.recoveryAction.length > 0, `${code} has a recovery action`);
    assert.ok(definition.remediation.length > 0, `${code} has remediation steps`);
    assert.ok(categories.has(definition.category));
  }

  assert.deepEqual(toExportFailure(new Error('boom')), {
    ok: false,
    code: 'EXPORT_FAILED',
    message: EXPORT_ERRORS.EXPORT_FAILED.message,
    category: 'INTERNAL',
    retryable: true,
    recoveryAction: EXPORT_ERRORS.EXPORT_FAILED.recoveryAction,
    remediation: EXPORT_ERRORS.EXPORT_FAILED.remediation,
  });

  const preserved = toExportFailure(
    new ExportError('INVALID_EXPORT_RECIPIENT', { message: 'custom recipient message' })
  );
  assert.equal(preserved.code, 'INVALID_EXPORT_RECIPIENT');
  assert.equal(preserved.message, 'custom recipient message');
  assert.equal(preserved.retryable, false);
  assert.equal(isExportError(new Error('boom')), false);

  // Export actions read invoice state; they never write it.
  const browser = installBrowser();
  try {
    const snapshot = structuredClone(PAID_INVOICE);
    openInvoicePDF(PAID_INVOICE);
    shareInvoiceByEmail(PAID_INVOICE);
    downloadInvoiceCSV([PAID_INVOICE]);
    assert.deepEqual(PAID_INVOICE, snapshot);
  } finally {
    browser.restore();
  }
});

/**
 * Installs the smallest browser surface `lib/export.ts` touches, so the
 * browser-dependent paths can be exercised without a DOM.
 */
function installBrowser(options = {}) {
  const calls = {
    clicked: 0,
    focused: 0,
    closed: 0,
    written: [],
    revoked: [],
    blobs: [],
    attributes: {},
    opened: null,
  };

  const anchor = {
    style: {},
    parentNode: { removeChild() {} },
    setAttribute(name, value) {
      calls.attributes[name] = value;
    },
    click() {
      calls.clicked += 1;
    },
  };

  const fakeDocument = {
    activeElement: {
      focus() {
        calls.focused += 1;
      },
    },
    body: { appendChild() {} },
    createElement() {
      return anchor;
    },
  };

  const popup =
    options.popup === null
      ? null
      : {
          document: {
            write(html) {
              if (options.writeThrows) throw new Error('document.write blocked');
              calls.written.push(html);
            },
            close() {},
          },
          print() {},
          close() {
            calls.closed += 1;
          },
          onload: null,
          onafterprint: null,
        };

  const location = { origin: 'https://quittance.test', href: '' };
  const fakeWindow = {
    location,
    open(url, target, features) {
      calls.opened = { url, target, features };
      if (options.openThrows) throw new Error('window.open blocked');
      return popup;
    },
  };

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Blob: globalThis.Blob,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };

  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.Blob = class TestBlob {
    constructor(parts, blobOptions = {}) {
      this.parts = parts;
      this.type = blobOptions.type;
      calls.blobs.push({ parts, type: blobOptions.type });
    }
  };
  URL.createObjectURL = () => {
    if (options.createObjectUrlThrows) throw new Error('createObjectURL blocked');
    return 'blob:export';
  };
  URL.revokeObjectURL = (url) => calls.revoked.push(url);

  return {
    calls,
    anchor,
    location,
    restore() {
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.Blob === undefined) delete globalThis.Blob;
      else globalThis.Blob = previous.Blob;
      URL.createObjectURL = previous.createObjectURL;
      URL.revokeObjectURL = previous.revokeObjectURL;
    },
  };
}
