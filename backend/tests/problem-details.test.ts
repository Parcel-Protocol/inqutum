/**
 * Problem-details taxonomy and error contract drift tests (#260).
 *
 *  1. tests/fixtures/error-codes.lock.json pins every public error code with
 *     its problem type, HTTP status, category and retryability. Removing,
 *     renaming or changing a locked code fails here; adding a code fails until
 *     the lockfile and docs/ERROR_CODES.md are updated in the same change.
 *  2. Every code literal emitted under src/ must be registered, and the HTTP
 *     status it is sent with must match the registered status.
 *  3. Every registered code is documented in docs/ERROR_CODES.md.
 *  4. application/problem+json is opt-in and leaves the legacy envelope
 *     untouched for clients that do not ask for it.
 *  5. Infrastructure detail (hosts, SQL, provider text) never reaches callers.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  AppError,
  DOMAIN_ERROR_TAXONOMY,
  buildUserSafeErrorResponse,
} from '../src/errors/error-taxonomy';
import {
  PROBLEM_JSON,
  PROBLEM_TYPE_PREFIX,
  problemDetailsNegotiation,
  problemTypeFor,
  toProblemDetails,
  wantsProblemDetails,
} from '../src/errors/problem-details';
import { sendFailure, sendVerificationFailure } from '../src/types/api';

const LOCK_PATH = path.join(__dirname, 'fixtures/error-codes.lock.json');
const DOC_PATH = path.join(__dirname, '../../docs/ERROR_CODES.md');
const SRC_DIR = path.join(__dirname, '../src');

interface LockedCode {
  type: string;
  status: number;
  category: string;
  retryable: boolean;
}

const lock: { version: number; codes: Record<string, LockedCode> } = JSON.parse(
  fs.readFileSync(LOCK_PATH, 'utf8')
);

/**
 * `code: '...'` literals under src/ that are not API error codes. Each entry
 * names the file it lives in so the allowlist cannot silently cover a new
 * error emitted elsewhere.
 */
const NON_ERROR_CODE_LITERALS: Record<string, string> = {
  XLM: 'src/utils/asset-helpers.ts', // Stellar native asset code
  ALLOWED: 'src/audit/impersonation.ts', // policy decision, never sent as an HTTP error
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
}

/** Patterns that bind a literal HTTP status to a literal error code. */
const STATUS_BINDINGS = [
  /sendFailure\(\s*res,\s*(\d{3}),[^;]*?\bcode: '([A-Z0-9_]+)'/g,
  /res\.status\((\d{3})\)\.json\(\{[^;]*?\bcode: '([A-Z0-9_]+)'/g,
  /webhookError\(res, (\d{3}), '([A-Z0-9_]+)'/g,
];

describe('Error code lockfile (#260)', () => {
  it('keeps every locked code with the same type, status, category and retryability', () => {
    for (const [code, locked] of Object.entries(lock.codes)) {
      const def = DOMAIN_ERROR_TAXONOMY[code];
      assert.ok(
        def,
        `${code} was removed or renamed. Public codes are permanent: restore it and deprecate it in docs/ERROR_CODES.md instead.`
      );
      assert.equal(problemTypeFor(code), locked.type, `${code}: problem type URI changed`);
      assert.equal(def.httpStatus, locked.status, `${code}: HTTP status changed in place; add a new code instead`);
      assert.equal(def.category, locked.category, `${code}: category changed in place; add a new code instead`);
      assert.equal(def.retryable, locked.retryable, `${code}: retryability changed in place; add a new code instead`);
    }
  });

  it('requires new codes to be added to the lockfile deliberately', () => {
    const unlocked = Object.keys(DOMAIN_ERROR_TAXONOMY).filter((code) => !(code in lock.codes));
    assert.deepEqual(
      unlocked,
      [],
      `New codes ${unlocked.join(', ')} must be appended to tests/fixtures/error-codes.lock.json and documented in docs/ERROR_CODES.md`
    );
  });

  it('keys every definition by its own code, in SCREAMING_SNAKE_CASE', () => {
    for (const [key, def] of Object.entries(DOMAIN_ERROR_TAXONOMY)) {
      assert.equal(def.code, key);
      assert.match(key, /^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('derives unique, stable problem type URNs', () => {
    const types = Object.keys(DOMAIN_ERROR_TAXONOMY).map(problemTypeFor);
    assert.equal(new Set(types).size, types.length);
    assert.equal(problemTypeFor('MEMO_MISMATCH'), 'urn:inqutum:problem:memo-mismatch');
    for (const type of types) assert.ok(type.startsWith(PROBLEM_TYPE_PREFIX));
  });
});

describe('Emitted codes stay inside the taxonomy (#260)', () => {
  const files = sourceFiles(SRC_DIR);

  it('registers every code literal emitted under src/', () => {
    const unregistered: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bcode: '([A-Z][A-Z0-9_]{2,})'/g)) {
        const code = match[1];
        if (DOMAIN_ERROR_TAXONOMY[code]) continue;
        if (NON_ERROR_CODE_LITERALS[code] === relative(file)) continue;
        unregistered.push(`${relative(file)}: ${code}`);
      }
      for (const match of text.matchAll(/webhookError\(res, \d{3}, '([A-Z0-9_]+)'/g)) {
        if (!DOMAIN_ERROR_TAXONOMY[match[1]]) unregistered.push(`${relative(file)}: ${match[1]}`);
      }
    }
    assert.deepEqual(unregistered, [], 'register these codes in DOMAIN_ERROR_TAXONOMY or reuse an existing one');
  });

  it('sends each code with its registered HTTP status', () => {
    const mismatches: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of STATUS_BINDINGS) {
        for (const match of text.matchAll(pattern)) {
          const [, status, code] = match;
          const def = DOMAIN_ERROR_TAXONOMY[code];
          if (def && def.httpStatus !== Number(status)) {
            mismatches.push(`${relative(file)}: ${code} sent as ${status}, registered as ${def.httpStatus}`);
          }
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });
});

describe('docs/ERROR_CODES.md coverage (#260)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');

  it('documents every registered code with its status', () => {
    for (const [code, def] of Object.entries(DOMAIN_ERROR_TAXONOMY)) {
      const row = new RegExp(`^\\| \`${code}\` \\| ${def.httpStatus} \\| ${def.category} \\| ${def.retryable ? 'yes' : 'no'} \\|`, 'm');
      assert.match(doc, row, `docs/ERROR_CODES.md is missing or stale for ${code}`);
    }
  });
});

describe('User-safe messages (#260)', () => {
  it('keeps taxonomy messages free of internal detail', () => {
    for (const def of Object.values(DOMAIN_ERROR_TAXONOMY)) {
      for (const text of [def.userSafeMessage, def.recoveryAction]) {
        assert.ok(text.length > 0, `${def.code}: empty message`);
        assert.ok(!text.includes('\n'), `${def.code}: multi-line message`);
        assert.doesNotMatch(text, /:\/\/|\bat \w+ \(|SELECT |INSERT |stack/i, `${def.code}: looks internal`);
      }
    }
  });

  it('does not echo raw network error text', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.4.17:8000'), { code: 'ECONNREFUSED' });
    const body = buildUserSafeErrorResponse(err, 'corr-1');
    assert.equal(body.code, 'HORIZON_UNAVAILABLE');
    assert.equal(body.error, DOMAIN_ERROR_TAXONOMY.HORIZON_UNAVAILABLE.userSafeMessage);
    assert.ok(!body.error.includes('10.0.4.17'));
  });

  it('still echoes explicit AppError messages chosen by the thrower', () => {
    const body = buildUserSafeErrorResponse(new AppError('HORIZON_UNAVAILABLE', 'Horizon is slow, retry shortly'));
    assert.equal(body.error, 'Horizon is slow, retry shortly');
  });

  it('still echoes caller-facing validation messages', () => {
    const body = buildUserSafeErrorResponse(new AppError('INVOICE_NOT_FOUND', 'Invoice abc not found'));
    assert.equal(body.error, 'Invoice abc not found');
  });
});

describe('Accept negotiation (#260)', () => {
  it('opts in only when application/problem+json is listed explicitly', () => {
    assert.equal(wantsProblemDetails(undefined), false);
    assert.equal(wantsProblemDetails('application/json'), false);
    assert.equal(wantsProblemDetails('*/*'), false);
    assert.equal(wantsProblemDetails('text/html,application/xhtml+xml,*/*;q=0.8'), false);
    assert.equal(wantsProblemDetails('application/problem+json'), true);
    assert.equal(wantsProblemDetails('application/json, application/problem+json;q=0.9'), true);
    assert.equal(wantsProblemDetails('Application/Problem+JSON'), true);
    assert.equal(wantsProblemDetails('application/problem+json;q=0'), false);
  });
});

describe('toProblemDetails (#260)', () => {
  it('maps a registered failure envelope to RFC 9457 members plus extensions', () => {
    const problem = toProblemDetails(
      {
        success: false,
        error: 'Memo INV-9 does not match INV-1',
        code: 'MEMO_MISMATCH',
        category: 'SETTLEMENT',
        retryable: false,
        recoveryAction: 'Include the exact invoice memo in your transaction memo field before sending.',
        correlationId: 'corr-7',
        timestamp: '2026-10-16T00:00:00.000Z',
      },
      400,
      '/api/invoices/abc/verify'
    );

    assert.deepEqual(problem, {
      type: 'urn:inqutum:problem:memo-mismatch',
      title: DOMAIN_ERROR_TAXONOMY.MEMO_MISMATCH.userSafeMessage,
      status: 400,
      detail: 'Memo INV-9 does not match INV-1',
      instance: '/api/invoices/abc/verify',
      code: 'MEMO_MISMATCH',
      category: 'SETTLEMENT',
      retryable: false,
      remediation: 'Include the exact invoice memo in your transaction memo field before sending.',
      correlationId: 'corr-7',
      timestamp: '2026-10-16T00:00:00.000Z',
    });
  });

  it('falls back to about:blank for an unregistered 4xx code', () => {
    const problem = toProblemDetails({ success: false, error: 'Nope', code: 'SOMETHING_NEW' }, 422);
    assert.equal(problem.type, 'about:blank');
    assert.equal(problem.title, 'Unprocessable Entity');
    assert.equal(problem.code, 'SOMETHING_NEW');
    assert.equal(problem.detail, 'Nope');
  });

  it('never forwards the message of an unregistered 5xx', () => {
    const problem = toProblemDetails(
      { success: false, error: 'relation "invoices" does not exist at pg://db:5432' },
      500
    );
    assert.equal(problem.code, 'INTERNAL_ERROR');
    assert.equal(problem.type, problemTypeFor('INTERNAL_ERROR'));
    assert.equal(problem.detail, DOMAIN_ERROR_TAXONOMY.INTERNAL_ERROR.userSafeMessage);
    assert.equal(problem.retryable, true);
  });
});

describe('problemDetailsNegotiation middleware (#260)', () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).correlationId = 'corr-mw';
      next();
    });
    app.use(problemDetailsNegotiation());
    app.get('/ok', (_req, res) => res.json({ success: true, data: { id: 1 } }));
    app.get('/raw-error', (_req, res) => res.status(503).json({ status: 'unhealthy' }));
    app.get('/send-failure', (_req, res) =>
      sendFailure(res, 404, 'Export not found', { code: 'EXPORT_NOT_FOUND', correlationId: 'corr-mw' })
    );
    app.get('/verification', (_req, res) =>
      sendVerificationFailure(res, 400, 'AMOUNT_MISMATCH', 'Amount 9 does not match 10', 'corr-mw')
    );
    app.get('/handwritten', (_req, res) =>
      res.status(409).json({ success: false, code: 'JOB_NOT_DEAD', error: 'Only dead-lettered jobs can be retried' })
    );
    app.get('/leaky-500', (_req, res) => sendFailure(res, 500, 'ENOENT: /srv/app/secrets.json'));

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function get(urlPath: string, accept?: string): Promise<{ status: number; type: string; vary: string; body: any }> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: urlPath, headers: accept ? { accept } : {} }, (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type'] ?? ''),
              vary: String(res.headers.vary ?? ''),
              body: JSON.parse(raw),
            })
          );
        })
        .on('error', reject);
    });
  }

  it('leaves the legacy envelope byte-compatible when the client does not opt in', async () => {
    const res = await get('/send-failure', 'application/json');
    assert.equal(res.status, 404);
    assert.match(res.type, /^application\/json/);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'category',
      'code',
      'correlationId',
      'error',
      'recoveryAction',
      'retryable',
      'success',
      'timestamp',
    ]);
    assert.equal(res.body.code, 'EXPORT_NOT_FOUND');
    assert.match(res.vary, /Accept/i);
  });

  it('serves application/problem+json when asked', async () => {
    const res = await get('/send-failure?requester=G123', PROBLEM_JSON);
    assert.equal(res.status, 404);
    assert.match(res.type, /^application\/problem\+json/);
    assert.equal(res.body.type, 'urn:inqutum:problem:export-not-found');
    assert.equal(res.body.status, 404);
    assert.equal(res.body.code, 'EXPORT_NOT_FOUND');
    assert.equal(res.body.detail, 'Export not found');
    assert.equal(res.body.instance, '/send-failure', 'query string must not be echoed');
    assert.equal(res.body.correlationId, 'corr-mw');
    assert.ok(res.body.remediation.length > 0);
    assert.equal(res.body.success, undefined);
  });

  it('covers verification failures and hand-written route envelopes too', async () => {
    const verification = await get('/verification', PROBLEM_JSON);
    assert.equal(verification.body.type, 'urn:inqutum:problem:amount-mismatch');
    assert.equal(verification.body.detail, 'Amount 9 does not match 10');

    const handwritten = await get('/handwritten', PROBLEM_JSON);
    assert.equal(handwritten.status, 409);
    assert.equal(handwritten.body.code, 'JOB_NOT_DEAD');
    assert.equal(handwritten.body.category, 'LIFECYCLE');
  });

  it('hides the message of an unregistered 5xx', async () => {
    const res = await get('/leaky-500', PROBLEM_JSON);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('secrets.json'));
  });

  it('does not touch success bodies or raw (non-envelope) error bodies', async () => {
    const ok = await get('/ok', PROBLEM_JSON);
    assert.deepEqual(ok.body, { success: true, data: { id: 1 } });
    assert.match(ok.type, /^application\/json/);

    const raw = await get('/raw-error', PROBLEM_JSON);
    assert.equal(raw.status, 503);
    assert.deepEqual(raw.body, { status: 'unhealthy' });
  });
});
