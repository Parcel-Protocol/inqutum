/**
 * Client and view model for the partial-failure operator dashboard (#383).
 * Normal, failure, retry and authorization paths, with an injected transport.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OpsApiError,
  buildQuery,
  clip,
  createOpsFailuresClient,
  describeOpsError,
  isOpsApiError,
  errorKind,
  formatAge,
  nextStep,
  parseDetail,
  parseItem,
  parseView,
} = require('../lib/ops-failures.ts');

const item = (over = {}) => ({
  id: 'job-1',
  operationType: 'email.invoice',
  invoiceId: 'inv-1',
  severity: 'critical',
  ageBucket: 'under_1h',
  ageMinutes: 5,
  stale: false,
  retryable: true,
  attempts: 3,
  lastError: 'ETIMEDOUT',
  recoveryAction: 'retry',
  links: { inspect: '/ops/partial-failures/job-1', retry: '/ops/partial-failures/job-1/retry', remediation: 'docs' },
  cause: { code: 'TIMEOUT', userActionRequired: false, userAction: null },
  userActionRequired: false,
  ...over,
});

const view = (items = [item()]) => ({
  generatedAt: '2026-11-01T00:00:00.000Z',
  items,
  total: items.length,
  summary: { unresolved: items.length, retryable: 1, userActionRequired: 0, bySeverity: { critical: 1, error: 0, warning: 0 }, byOperationType: { 'email.invoice': 1 } },
});

/** A transport that records requests and answers from a queue. */
function transport(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  fn.calls = calls;
  return fn;
}
const ok = (data) => ({ status: 200, body: { success: true, data } });
const client = (fetch) => createOpsFailuresClient({ baseUrl: 'https://api.test/api/', fetch });

test('buildQuery keeps only set fields, trims text, and clamps the limit', () => {
  assert.equal(buildQuery(), '');
  assert.equal(buildQuery({ severity: '', operationType: '  ' }), '');
  assert.equal(
    buildQuery({ severity: 'critical', operationType: ' email ', stale: false, retryable: true, userActionRequired: false, invoiceId: 'inv 1', limit: 9999 }),
    '?severity=critical&operationType=email&invoiceId=inv+1&stale=false&retryable=true&userActionRequired=false&limit=500'
  );
  assert.equal(buildQuery({ limit: 0 }), '?limit=1');
  assert.equal(buildQuery({ limit: Number.NaN }), '');
});

test('list sends the bearer token and filter, and parses the view', async () => {
  const fetch = transport(ok(view()));
  const result = await client(fetch).list('secret-token', { severity: 'critical' });
  assert.equal(fetch.calls[0].url, 'https://api.test/api/ops/partial-failures?severity=critical');
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(result.items[0].id, 'job-1');
  assert.equal(result.summary.bySeverity.critical, 1);
});

test('authorization: a missing token fails before any request is sent', async () => {
  const fetch = transport(ok(view()));
  await assert.rejects(client(fetch).list(''), (e) => e instanceof OpsApiError && e.kind === 'unauthorized');
  assert.equal(fetch.calls.length, 0);
});

test('authorization: 401 and 403 map to distinct kinds, and the token is never echoed in the error', async () => {
  const unauthorized = await client(transport({ status: 401, body: { success: false, code: 'UNAUTHORIZED', error: 'Invalid or missing admin token' } }))
    .list('hunter2')
    .catch((e) => e);
  assert.equal(unauthorized.kind, 'unauthorized');
  assert.equal(unauthorized.retriable, false);
  const disabled = await client(transport({ status: 403, body: { success: false, code: 'JOBS_ADMIN_DISABLED', error: 'Job inspection is not enabled' } }))
    .list('hunter2')
    .catch((e) => e);
  assert.equal(disabled.kind, 'disabled');
  for (const error of [unauthorized, disabled]) {
    assert.ok(!describeOpsError(error).includes('hunter2'));
    assert.ok(!JSON.stringify({ m: error.message, c: error.code }).includes('hunter2'));
  }
  assert.match(describeOpsError(unauthorized), /token was rejected/);
  assert.match(describeOpsError(disabled), /not enabled on this deployment/);
});

test('failure: network errors and 5xx are retriable and say nothing changed', async () => {
  const network = await client(transport(new TypeError('fetch failed'))).list('t').catch((e) => e);
  assert.equal(network.kind, 'unavailable');
  assert.equal(network.retriable, true);
  const server = await client(transport({ status: 503, body: { success: false, code: 'X', error: 'down' } })).list('t').catch((e) => e);
  assert.equal(server.retriable, true);
  assert.match(describeOpsError(server), /Nothing was changed/);
});

test('failure: an unparseable or wrongly shaped body is an error, not a crash', async () => {
  const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } };
  const bad = createOpsFailuresClient({ baseUrl: 'https://api.test/api', fetch: async () => notJson });
  await assert.rejects(bad.list('t'), (e) => e.kind === 'unavailable' && e.code === 'BAD_RESPONSE');
  await assert.rejects(client(transport(ok('nope'))).list('t'), (e) => e.code === 'BAD_RESPONSE');
  await assert.rejects(client(transport({ status: 200, body: { success: false } })).list('t'), (e) => e.code === 'BAD_RESPONSE');
});

test('failure: a request that never answers is aborted at the timeout', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = createOpsFailuresClient({ baseUrl: 'https://api.test/api', fetch: hang, timeoutMs: 20 });
  await assert.rejects(slow.list('t'), (e) => e.kind === 'unavailable' && e.code === 'NETWORK');
});

test('error kinds follow the status the server uses for each refusal', () => {
  assert.deepEqual([401, 403, 404, 400, 422, 409, 500, 429].map(errorKind), ['unauthorized', 'disabled', 'not_found', 'invalid', 'user_action', 'conflict', 'unavailable', 'unavailable']);
  assert.match(describeOpsError(new OpsApiError('user_action', 422, 'USER_ACTION_REQUIRED', 'Update the customer email address on the invoice.')), /customer email/);
  assert.match(describeOpsError(new OpsApiError('not_found', 404, 'NOT_FOUND', '')), /no longer exists/);
  assert.equal(describeOpsError(new Error('x')), 'Something went wrong. Try again.');
});

test('parseItem drops malformed rows and defaults unknown fields safely', () => {
  assert.equal(parseItem(null), null);
  assert.equal(parseItem({}), null);
  assert.equal(parseItem({ id: '' }), null);
  const parsed = parseItem({ id: 'x', severity: 'bogus', links: { retry: '/r' } });
  assert.equal(parsed.severity, 'error');
  assert.equal(parsed.operationType, 'unknown');
  assert.equal(parsed.recoveryAction, 'inspect');
  assert.equal(parsed.cause.code, 'UNKNOWN');
});

test('a failure that needs the user never exposes a retry link, even if the server sent one', () => {
  const parsed = parseItem(item({ userActionRequired: true, cause: { code: 'INVALID_RECIPIENT', userActionRequired: true, userAction: 'Update the customer email address.' } }));
  assert.equal(parsed.links.retry, null);
  assert.equal(nextStep(parsed).kind, 'contact_user');
  assert.match(nextStep(parsed).label, /customer email/);
});

test('nextStep distinguishes retry from inspect', () => {
  assert.equal(nextStep(parseItem(item())).kind, 'retry');
  assert.equal(nextStep(parseItem(item({ links: { inspect: '/i', retry: null, remediation: '' } }))).kind, 'inspect');
});

test('parseView filters bad rows and tolerates missing summary fields', () => {
  const parsed = parseView({ items: [item(), { nope: true }, null] });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.total, 1);
  assert.deepEqual(parsed.summary.bySeverity, { critical: 0, error: 0, warning: 0 });
  assert.throws(() => parseView(null), (e) => e instanceof OpsApiError);
});

test('detail encodes the id and clips long history messages', async () => {
  const long = 'x'.repeat(1000);
  const fetch = transport(ok({ item: item(), history: [{ attempt: 1, at: 't', message: long, cause: 'TIMEOUT' }], state: 'open' }));
  const detail = await client(fetch).detail('t', 'a/b?c');
  assert.equal(fetch.calls[0].url, 'https://api.test/api/ops/partial-failures/a%2Fb%3Fc');
  assert.ok(detail.history[0].message.length <= 300);
  assert.equal(parseDetail({ state: 'weird', history: 'no' }).state, 'open');
  assert.throws(() => parseDetail(3), (e) => e instanceof OpsApiError);
});

test('retry sends the idempotency key and reports duplicates', async () => {
  const fetch = transport(ok({ status: 'requeued', job: { id: 'job-1' } }), ok({ status: 'duplicate', job: { id: 'job-1' } }));
  const c = client(fetch);
  assert.deepEqual(await c.retry('t', 'job-1', 'key-12345678'), { status: 'requeued', jobId: 'job-1' });
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].headers['Idempotency-Key'], 'key-12345678');
  assert.equal(fetch.calls[0].url, 'https://api.test/api/ops/partial-failures/job-1/retry');
  assert.equal((await c.retry('t', 'job-1', 'key-12345678')).status, 'duplicate');
});

test('retry surfaces the server refusals the UI must not paper over', async () => {
  const user = await client(transport({ status: 422, body: { success: false, code: 'USER_ACTION_REQUIRED', error: 'Update the customer email address on the invoice.' } })).retry('t', 'j', 'key-12345678').catch((e) => e);
  assert.equal(user.kind, 'user_action');
  assert.equal(user.retriable, false);
  const conflict = await client(transport({ status: 409, body: { success: false, code: 'RETRY_IN_PROGRESS', error: 'A retry for this job is already running' } })).retry('t', 'j', 'key-12345678').catch((e) => e);
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.code, 'RETRY_IN_PROGRESS');
});

test('formatAge and clip', () => {
  assert.equal(formatAge(0), 'under 1 min');
  assert.equal(formatAge(Number.NaN), 'under 1 min');
  assert.equal(formatAge(5), '5 min');
  assert.equal(formatAge(125), '2 h');
  assert.equal(formatAge(60 * 72), '3 d');
  assert.equal(clip(null), '');
  assert.equal(clip('  hi  '), 'hi');
  assert.equal(clip('x'.repeat(400)).length, 300);
  assert.ok(clip('x'.repeat(400)).endsWith('…'));
});

test('isOpsApiError recognises an error from another copy of the module, and nothing else', () => {
  assert.equal(isOpsApiError(new OpsApiError('conflict', 409, 'X', 'm')), true);
  assert.equal(isOpsApiError({ name: 'OpsApiError', kind: 'unauthorized', status: 401 }), true);
  for (const other of [null, undefined, 'x', new Error('x'), { name: 'OpsApiError' }, { kind: 'conflict', status: 409 }]) {
    assert.equal(isOpsApiError(other), false);
  }
  assert.match(describeOpsError({ name: 'OpsApiError', kind: 'unauthorized', status: 401, message: '' }), /token was rejected/);
});
