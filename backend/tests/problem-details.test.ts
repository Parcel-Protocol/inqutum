/**
 * Issue #439 — Stable problem-details error taxonomy.
 *
 * Covers the four acceptance-criteria paths:
 *   1. Normal path  — toProblemDetails produces all RFC 7807 required fields
 *   2. Failure path — every error category maps to a stable, non-leaking document
 *   3. Retry path   — retryable codes carry retryable:true and retry guidance
 *   4. Auth path    — 401/403 codes carry the right category and no internal details
 *
 * Additionally verifies:
 *   - sendProblemDetails sets Content-Type: application/problem+json
 *   - problemTypeUri produces stable, deterministic URIs
 *   - toProblemDetails never leaks SQL, secrets, or stack traces
 *   - fieldErrors are forwarded when present
 *   - all DOMAIN_ERROR_TAXONOMY codes produce valid problem-details documents
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  toProblemDetails,
  sendProblemDetails,
  problemTypeUri,
  PROBLEM_TYPE_BASE,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
} from '../src/errors/problem-details';
import { DOMAIN_ERROR_TAXONOMY } from '../src/errors/error-taxonomy';
import { VERIFICATION_MESSAGES } from '../src/services/payment-verification';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  const captured: { status?: number; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    captured,
  };
  return res as unknown as { status: any; setHeader: any; json: any; captured: typeof captured };
}

// ---------------------------------------------------------------------------
// 1. Normal path — RFC 7807 structure
// ---------------------------------------------------------------------------

describe('toProblemDetails — RFC 7807 structure (normal path)', () => {
  it('populates all five RFC-required fields', () => {
    const doc = toProblemDetails({
      success: false,
      error: 'Memo mismatch',
      code: 'MEMO_MISMATCH',
    });

    assert.ok(typeof doc.type === 'string' && doc.type.startsWith('https://'), 'type must be an https URI');
    assert.ok(typeof doc.title === 'string' && doc.title.length > 0, 'title must be non-empty');
    assert.ok(typeof doc.status === 'number' && doc.status >= 400 && doc.status < 600, 'status must be 4xx/5xx');
    assert.ok(typeof doc.detail === 'string' && doc.detail.length > 0, 'detail must be non-empty');
    assert.ok('success' in doc && doc.success === false, 'must retain success:false for envelope compat');
  });

  it('sets instance when correlationId is supplied', () => {
    const doc = toProblemDetails({
      success: false,
      error: 'Not found',
      code: 'INVOICE_NOT_FOUND',
      correlationId: 'corr-abc-123',
    });

    assert.ok(doc.instance?.includes('corr-abc-123'), 'instance must embed correlationId');
    assert.equal(doc.correlationId, 'corr-abc-123');
  });

  it('omits instance when no correlationId is given', () => {
    const doc = toProblemDetails({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
    assert.equal('instance' in doc, false);
  });

  it('type URI follows the stable lower-kebab-case pattern', () => {
    assert.equal(problemTypeUri('MEMO_MISMATCH'), `${PROBLEM_TYPE_BASE}memo-mismatch`);
    assert.equal(problemTypeUri('VALIDATION_FAILED'), `${PROBLEM_TYPE_BASE}validation-failed`);
    assert.equal(problemTypeUri('INVOICE_NOT_FOUND'), `${PROBLEM_TYPE_BASE}invoice-not-found`);
  });

  it('fills title and recoveryAction from DOMAIN_ERROR_TAXONOMY when caller omits them', () => {
    const doc = toProblemDetails({ success: false, error: 'x', code: 'AMOUNT_MISMATCH' });
    const taxonomy = DOMAIN_ERROR_TAXONOMY['AMOUNT_MISMATCH'];

    assert.equal(doc.title, taxonomy.userSafeMessage);
    assert.equal(doc.recoveryAction, taxonomy.recoveryAction);
  });

  it('attaches remediation from taxonomy when caller does not supply it', () => {
    const doc = toProblemDetails({ success: false, error: 'x', code: 'MEMO_MISMATCH' });
    assert.deepEqual(doc.remediation, DOMAIN_ERROR_TAXONOMY['MEMO_MISMATCH'].remediation);
  });

  it('forwards fieldErrors when the caller supplies them', () => {
    const fields = [
      { field: 'sellerPublicKey', code: 'INVALID_VALUE', message: 'must start with G', hint: 'Use a 56-char G address' },
      { field: 'amount', code: 'BELOW_MIN', message: 'must be positive', hint: 'Provide a positive number' },
    ];
    const doc = toProblemDetails({
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      fieldErrors: fields,
    });
    assert.deepEqual(doc.fieldErrors, fields);
  });

  it('produces a stable timestamp in ISO-8601 format', () => {
    const doc = toProblemDetails({ success: false, error: 'err', code: 'INTERNAL_ERROR' });
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(doc.timestamp), 'timestamp must be ISO-8601');
  });

  it('honours an explicit httpStatus argument over the taxonomy default', () => {
    const doc = toProblemDetails({ success: false, error: 'x', code: 'MEMO_MISMATCH' }, 422);
    assert.equal(doc.status, 422);
  });
});

// ---------------------------------------------------------------------------
// 2. Failure path — all error categories map to valid documents
// ---------------------------------------------------------------------------

describe('toProblemDetails — failure path: all error categories', () => {
  const verificationCodes = Object.keys(VERIFICATION_MESSAGES);

  for (const code of verificationCodes) {
    it(`SETTLEMENT code ${code} produces a valid problem-details document`, () => {
      const msg = VERIFICATION_MESSAGES[code as keyof typeof VERIFICATION_MESSAGES];
      const doc = toProblemDetails({ success: false, error: msg, code });

      assert.ok(doc.type.startsWith(PROBLEM_TYPE_BASE), `${code}: type must use the problem-type base`);
      assert.ok(doc.title.length > 0, `${code}: title must be non-empty`);
      assert.ok(doc.status >= 400, `${code}: status must indicate error`);
      assert.ok(doc.detail.length > 0, `${code}: detail must be non-empty`);
      assert.ok(doc.recoveryAction.length > 0, `${code}: recoveryAction must be non-empty`);
      assert.ok(Array.isArray(doc.remediation) && doc.remediation!.length > 0, `${code}: remediation must be populated`);
    });
  }

  it('VALIDATION category — VALIDATION_FAILED carries retryable:false', () => {
    const doc = toProblemDetails({ success: false, error: 'Invalid input', code: 'VALIDATION_FAILED' });
    assert.equal(doc.retryable, false);
    assert.equal(doc.category, 'VALIDATION');
  });

  it('LIFECYCLE category — INVOICE_EXPIRED carries retryable:false and status 400', () => {
    const doc = toProblemDetails({ success: false, error: VERIFICATION_MESSAGES.INVOICE_EXPIRED, code: 'INVOICE_EXPIRED' });
    assert.equal(doc.retryable, false);
    assert.equal(doc.status, 400);
  });

  it('NOT_FOUND category — INVOICE_NOT_FOUND carries status 404', () => {
    const doc = toProblemDetails({ success: false, error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    assert.equal(doc.status, 404);
  });

  it('unknown code falls back to INTERNAL_ERROR taxonomy without throwing', () => {
    const doc = toProblemDetails({ success: false, error: 'boom', code: 'TOTALLY_UNKNOWN_CODE_XYZ' });
    assert.equal(doc.status, 500);
    assert.equal(doc.retryable, true); // INTERNAL_ERROR is retryable
  });

  it('missing code falls back gracefully', () => {
    const doc = toProblemDetails({ success: false, error: 'oops' });
    assert.ok(doc.type.startsWith(PROBLEM_TYPE_BASE));
    assert.equal(typeof doc.status, 'number');
  });
});

// ---------------------------------------------------------------------------
// 3. Retry path — retryable codes carry correct guidance
// ---------------------------------------------------------------------------

describe('toProblemDetails — retry path', () => {
  const retryableCodes = [
    'TRANSACTION_NOT_FOUND',
    'HORIZON_UNAVAILABLE',
    'RATE_LIMITED',
    'CONFLICT',
    'INTERNAL_ERROR',
  ];

  for (const code of retryableCodes) {
    it(`${code} is marked retryable:true`, () => {
      const taxonomy = DOMAIN_ERROR_TAXONOMY[code];
      assert.ok(taxonomy, `${code} must exist in DOMAIN_ERROR_TAXONOMY`);
      assert.equal(taxonomy.retryable, true, `${code} must be retryable in the taxonomy`);

      const doc = toProblemDetails({ success: false, error: taxonomy.userSafeMessage, code });
      assert.equal(doc.retryable, true, `${code}: toProblemDetails must forward retryable:true`);
    });
  }

  it('TRANSACTION_NOT_FOUND has non-empty recoveryAction explaining the ledger delay', () => {
    const doc = toProblemDetails({ success: false, error: 'x', code: 'TRANSACTION_NOT_FOUND' });
    assert.ok(/5|seconds|retry|ledger/i.test(doc.recoveryAction), 'should mention ledger or retry timing');
  });

  it('RATE_LIMITED has remediation hints about backoff', () => {
    const doc = toProblemDetails({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
    assert.ok(doc.remediation && doc.remediation.length > 0, 'RATE_LIMITED must have remediation hints');
    assert.ok(doc.remediation!.some((s) => /backoff|retry|slow|wait/i.test(s)), 'hints should mention backoff');
  });

  it('caller-supplied retryable flag overrides taxonomy default', () => {
    // Force a non-retryable code to be retryable (hypothetical client override)
    const doc = toProblemDetails({ success: false, error: 'x', code: 'MEMO_MISMATCH', retryable: true });
    assert.equal(doc.retryable, true);
  });
});

// ---------------------------------------------------------------------------
// 4. Authorization path — 401/403 codes carry the right category, no leaks
// ---------------------------------------------------------------------------

describe('toProblemDetails — authorization path', () => {
  it('ADMIN_TOKEN_REQUIRED resolves to status 401 and AUTHORIZATION category', () => {
    const doc = toProblemDetails({ success: false, error: 'Invalid or missing admin token', code: 'UNAUTHORIZED' });
    assert.equal(doc.status, 401);
    assert.equal(doc.category, 'AUTHORIZATION');
  });

  it('UNAUTHORIZED_SELLER resolves to status 403 and AUTHORIZATION category', () => {
    const doc = toProblemDetails({ success: false, error: 'x', code: 'UNAUTHORIZED_SELLER' });
    assert.equal(doc.status, 403);
    assert.equal(doc.category, 'AUTHORIZATION');
    assert.equal(doc.retryable, false);
  });

  it('CORS_ORIGIN_DENIED resolves to status 403 without internal URL details', () => {
    const doc = toProblemDetails({
      success: false,
      error: 'Origin is not allowed by Quittance CORS policy',
      code: 'CORS_ORIGIN_DENIED',
    });
    assert.equal(doc.status, 403);
    assert.ok(!JSON.stringify(doc).includes('http://internal'), 'must not leak internal server URLs');
  });

  it('PERMISSION_DENIED resolves correctly', () => {
    const doc = toProblemDetails({ success: false, error: 'x', code: 'PERMISSION_DENIED' });
    assert.equal(doc.status, 403);
    assert.equal(doc.category, 'AUTHORIZATION');
  });
});

// ---------------------------------------------------------------------------
// 5. sendProblemDetails — Express helper sets Content-Type and status
// ---------------------------------------------------------------------------

describe('sendProblemDetails — Express helper', () => {
  it('sets Content-Type: application/problem+json', () => {
    const res = makeRes();
    sendProblemDetails(res as any, 400, { success: false, error: 'Memo mismatch', code: 'MEMO_MISMATCH' });

    assert.equal(res.captured.headers['content-type'], PROBLEM_CONTENT_TYPE);
  });

  it('sets the HTTP status on the response', () => {
    const res = makeRes();
    sendProblemDetails(res as any, 429, { success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
    assert.equal(res.captured.status, 429);
  });

  it('body has the five RFC-required fields', () => {
    const res = makeRes();
    sendProblemDetails(res as any, 404, { success: false, error: 'Not found', code: 'INVOICE_NOT_FOUND' });
    const body = res.captured.body as ProblemDetails;
    assert.ok(body.type?.startsWith('https://'));
    assert.ok(body.title?.length > 0);
    assert.equal(body.status, 404);
    assert.ok(body.detail?.length > 0);
    assert.equal(body.success, false);
  });
});

// ---------------------------------------------------------------------------
// 6. PII / secret redaction — toProblemDetails never leaks internals
// ---------------------------------------------------------------------------

describe('toProblemDetails — redaction', () => {
  it('strips SQL from detail', () => {
    const doc = toProblemDetails({
      success: false,
      error: "SELECT * FROM invoices WHERE wallet='GABC' failed: syntax error",
      code: 'INTERNAL_ERROR',
    });
    assert.ok(!doc.detail.includes('SELECT *'), 'SQL must be stripped from detail');
  });

  it('strips Stellar secret seeds from detail', () => {
    const secretSeed = 'S' + 'A'.repeat(55);
    const doc = toProblemDetails({
      success: false,
      error: `Seed=${secretSeed} caused an error`,
      code: 'INTERNAL_ERROR',
    });
    assert.ok(!doc.detail.includes(secretSeed), 'Stellar secret seed must not appear in detail');
  });

  it('strips postgres connection strings from detail', () => {
    const doc = toProblemDetails({
      success: false,
      error: 'connect ECONNREFUSED postgres://user:password@localhost:5432/db',
      code: 'INTERNAL_ERROR',
    });
    assert.ok(!doc.detail.includes('password'), 'DB password must not appear in detail');
  });

  it('redacts secrets from recovery guidance, remediation, and validation details', () => {
    const secretSeed = 'S' + 'B'.repeat(55);
    const bearerToken = 'Bearer abc.def.ghi';
    const doc = toProblemDetails({
      success: false,
      error: 'Request failed',
      code: 'INTERNAL_ERROR',
      recoveryAction: `Retry with ${bearerToken}`,
      remediation: [`Use connection postgres://user:db-password@localhost:5432/app`],
      fieldErrors: [{
        field: 'credential',
        code: 'INVALID_VALUE',
        message: `Invalid secret ${secretSeed}`,
        hint: `Authorization header: ${bearerToken}`,
      }],
    });

    const serialized = JSON.stringify(doc);
    assert.ok(!serialized.includes(secretSeed), 'Stellar secret seed must not appear anywhere in the document');
    assert.ok(!serialized.includes('abc.def.ghi'), 'bearer token must not appear anywhere in the document');
    assert.ok(!serialized.includes('db-password'), 'database password must not appear anywhere in the document');
    assert.ok(doc.recoveryAction.includes('[REDACTED_TOKEN]'));
    assert.ok(doc.remediation?.[0].includes('[REDACTED]'));
    assert.ok(doc.fieldErrors?.[0].message.includes('[REDACTED_SECRET_KEY]'));
    assert.ok(doc.fieldErrors?.[0].hint?.includes('[REDACTED_TOKEN]'));
  });
});

// ---------------------------------------------------------------------------
// 7. Full-catalog coverage — every code in DOMAIN_ERROR_TAXONOMY
// ---------------------------------------------------------------------------

describe('toProblemDetails — full taxonomy coverage', () => {
  it('every DOMAIN_ERROR_TAXONOMY code produces a valid ProblemDetails document', () => {
    for (const [code, entry] of Object.entries(DOMAIN_ERROR_TAXONOMY)) {
      const doc = toProblemDetails({ success: false, error: entry.userSafeMessage, code });

      assert.ok(doc.type.startsWith(PROBLEM_TYPE_BASE), `${code}: type must start with problem-type base`);
      assert.equal(doc.status, entry.httpStatus, `${code}: status mismatch`);
      assert.equal(doc.retryable, entry.retryable, `${code}: retryable mismatch`);
      assert.ok(doc.detail.length > 0, `${code}: detail must be non-empty`);
      assert.ok(doc.recoveryAction.length > 0, `${code}: recoveryAction must be non-empty`);
      assert.equal(doc.success, false);
    }
  });
});
