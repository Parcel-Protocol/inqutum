/**
 * Operator dashboard for unresolved partial failures (#383), rendered through
 * the shipped component in jsdom. Normal, failure, retry and authorization
 * paths, plus an axe audit of each state.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundle, installDom, getDom, render, runAxe, formatViolations } = require('./support/a11y-harness');

installDom();

const React = require('react');
const { act } = React;
const { PartialFailureDashboard } = loadBundle();
const { OpsApiError } = require('../lib/ops-failures.ts');

const TOKEN = 'super-secret-admin-token';

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
  lastError: 'ETIMEDOUT contacting mail provider',
  recoveryAction: 'retry',
  links: { inspect: '/i', retry: '/r', remediation: 'docs' },
  cause: { code: 'TIMEOUT', userActionRequired: false, userAction: null },
  userActionRequired: false,
  ...over,
});
const userItem = () =>
  item({
    id: 'job-2',
    operationType: 'email.reminder',
    severity: 'warning',
    userActionRequired: true,
    links: { inspect: '/i', retry: null, remediation: 'docs' },
    cause: { code: 'INVALID_RECIPIENT', userActionRequired: true, userAction: 'Update the customer email address on the invoice.' },
  });
const view = (items) => ({
  generatedAt: 't',
  items,
  total: items.length,
  summary: {
    unresolved: items.length,
    retryable: items.filter((i) => i.links.retry).length,
    userActionRequired: items.filter((i) => i.userActionRequired).length,
    bySeverity: { critical: items.filter((i) => i.severity === 'critical').length, error: 0, warning: items.filter((i) => i.severity === 'warning').length },
    byOperationType: {},
  },
});

/** A scriptable stand-in for the API client that records every call. */
function fakeClient(overrides = {}) {
  const calls = { list: [], detail: [], retry: [] };
  const client = {
    calls,
    async list(token, filter) {
      calls.list.push({ token, filter: { ...filter } });
      return overrides.list ? overrides.list(token, filter, calls.list.length) : view([item(), userItem()]);
    },
    async detail(token, id) {
      calls.detail.push({ token, id });
      return overrides.detail ? overrides.detail(token, id) : { item: item(), history: [{ attempt: 1, at: '2026-11-01T00:00:00Z', message: 'ETIMEDOUT', cause: 'TIMEOUT' }], state: 'open' };
    },
    async retry(token, id, key) {
      calls.retry.push({ token, id, key });
      return overrides.retry ? overrides.retry(token, id, key, calls.retry.length) : { status: 'requeued', jobId: id };
    },
  };
  return client;
}

const $ = (container, selector) => container.querySelector(selector);
const byText = (container, tag, text) => [...container.querySelectorAll(tag)].find((el) => el.textContent.includes(text));

async function type(input, value) {
  const { window } = getDom();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function choose(select, value) {
  const { window } = getDom();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const click = async (el) => act(async () => el.click());
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => getDom().window.setTimeout(r, 0)));
};

async function signedIn(client) {
  const mounted = await render(React.createElement(PartialFailureDashboard, { client }));
  await type($(mounted.container, '#ops-token'), TOKEN);
  await act(async () => $(mounted.container, 'form').dispatchEvent(new (getDom().window.Event)('submit', { bubbles: true, cancelable: true })));
  await settle();
  return mounted;
}

async function assertAxeClean(container, label) {
  const violations = await runAxe(container);
  // Length, not deepEqual: axe's arrays come from jsdom's realm and never deep-equal a local [].
  assert.equal(violations.length, 0, `${label}:\n${formatViolations(violations)}`);
}

test('authorization: nothing is requested until a token is entered, and an empty token is refused', async () => {
  const client = fakeClient();
  const { container, unmount } = await render(React.createElement(PartialFailureDashboard, { client }));
  assert.equal(client.calls.list.length, 0);
  const input = $(container, '#ops-token');
  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'off');
  await act(async () => $(container, 'form').dispatchEvent(new (getDom().window.Event)('submit', { bubbles: true, cancelable: true })));
  assert.match($(container, '#ops-token-error').textContent, /Enter the admin token/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(client.calls.list.length, 0);
  await assertAxeClean(container, 'sign-in with error');
  unmount();
});

test('normal: signs in, lists failures with the token, shows summary, severity as text, and retry only where it can help', async () => {
  const client = fakeClient();
  const { container, unmount } = await signedIn(client);
  assert.equal(client.calls.list.length, 1);
  assert.equal(client.calls.list[0].token, TOKEN);
  assert.ok(!container.innerHTML.includes(TOKEN), 'the token is never rendered');
  assert.equal(getDom().window.sessionStorage.length + getDom().window.localStorage.length, 0, 'the token is never stored');

  const rows = container.querySelectorAll('ul[aria-label="Unresolved failures"] > li');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Critical/);
  assert.match(rows[0].textContent, /email\.invoice/);
  assert.match(rows[0].textContent, /cause TIMEOUT/);
  assert.ok(byText(rows[0], 'button', 'Retry'), 'retryable failure offers Retry');
  assert.match(rows[1].textContent, /Needs the user/);
  assert.match(rows[1].textContent, /Update the customer email address/);
  assert.equal(byText(rows[1], 'button', 'Retry'), undefined, 'a failure only the user can fix offers no Retry');
  assert.match($(container, 'dl[aria-label="Summary"]').textContent, /Unresolved\s*2/);
  await assertAxeClean(container, 'populated list');
  unmount();
});

test('filters re-query the API with exactly the chosen filter', async () => {
  const client = fakeClient();
  const { container, unmount } = await signedIn(client);
  await choose($(container, '#f-severity'), 'critical');
  await settle();
  await choose($(container, '#f-retryable'), 'true');
  await settle();
  await choose($(container, '#f-user'), 'false');
  await settle();
  const last = client.calls.list.at(-1).filter;
  assert.equal(last.severity, 'critical');
  assert.equal(last.retryable, true);
  assert.equal(last.userActionRequired, false);
  assert.equal(last.stale, undefined);
  unmount();
});

test('a slow earlier response never overwrites a newer one', async () => {
  const gates = [];
  const client = fakeClient({
    list: (token, filter, n) =>
      n === 1 ? Promise.resolve(view([item()])) : new Promise((resolve) => gates.push(() => resolve(view([item({ id: `late-${n}`, operationType: `op-${n}` })])))),
  });
  const { container, unmount } = await signedIn(client);
  await choose($(container, '#f-severity'), 'critical'); // request 2 (slow)
  await choose($(container, '#f-severity'), 'warning'); // request 3 (slow)
  await act(async () => { gates[1](); }); // newest resolves first
  await settle();
  await act(async () => { gates[0](); }); // stale one resolves last
  await settle();
  assert.match(container.textContent, /op-3/);
  assert.ok(!container.textContent.includes('op-2'));
  unmount();
});

test('empty and filtered-empty states explain themselves, and filters can be cleared', async () => {
  const client = fakeClient({ list: (t, f) => view([]) });
  const { container, unmount } = await signedIn(client);
  assert.match(container.textContent, /No unresolved failures/);
  await assertAxeClean(container, 'empty');
  await choose($(container, '#f-severity'), 'critical');
  await settle();
  assert.match(container.textContent, /No failures match these filters/);
  await click(byText(container, 'button', 'Clear filters'));
  await settle();
  assert.equal(client.calls.list.at(-1).filter.severity, '');
  unmount();
});

test('failure: a failed load shows the reason and Try again recovers', async () => {
  let fail = true;
  const client = fakeClient({
    list: () => {
      if (fail) throw new OpsApiError('unavailable', 0, 'NETWORK', 'Could not reach the API');
      return view([item()]);
    },
  });
  const { container, unmount } = await signedIn(client);
  const alert = $(container, '[role="alert"]');
  assert.match(alert.textContent, /Could not load failures/);
  assert.match(alert.textContent, /Nothing was changed/);
  await assertAxeClean(container, 'load error');
  fail = false;
  await click(byText(container, 'button', 'Try again'));
  await settle();
  assert.equal(container.querySelectorAll('ul[aria-label="Unresolved failures"] > li').length, 1);
  unmount();
});

test('authorization: a 401 drops the token, returns to sign-in, and needs a new token', async () => {
  const client = fakeClient({ list: () => { throw new OpsApiError('unauthorized', 401, 'UNAUTHORIZED', 'Invalid or missing admin token'); } });
  const { container, unmount } = await signedIn(client);
  assert.ok($(container, '#ops-token'), 'back at the sign-in form');
  assert.match($(container, '#ops-token-error').textContent, /token was rejected/);
  assert.equal($(container, '#ops-token').value, '', 'the field is cleared');
  assert.equal(client.calls.list.length, 1, 'no further requests without a token');
  unmount();
});

test('authorization: 403 (ops disabled) is reported distinctly and the token is kept out of the message', async () => {
  const client = fakeClient({ list: () => { throw new OpsApiError('disabled', 403, 'JOBS_ADMIN_DISABLED', 'x'); } });
  const { container, unmount } = await signedIn(client);
  assert.match($(container, '[role="alert"]').textContent, /not enabled on this deployment/);
  assert.ok(!container.innerHTML.includes(TOKEN));
  unmount();
});

test('sign out clears the view and the token', async () => {
  const client = fakeClient();
  const { container, unmount } = await signedIn(client);
  await click(byText(container, 'button', 'Sign out'));
  assert.ok($(container, '#ops-token'));
  assert.equal(container.querySelectorAll('ul[aria-label="Unresolved failures"]').length, 0);
  assert.ok(!container.innerHTML.includes('email.invoice'));
  unmount();
});

test('details expand to the error history; a detail failure is announced', async () => {
  const client = fakeClient();
  const { container, unmount } = await signedIn(client);
  const button = byText(container, 'button', 'Details');
  await click(button);
  await settle();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(client.calls.detail[0].id, 'job-1');
  assert.match($(container, 'ol[aria-label="Error history"]').textContent, /Attempt 1 · TIMEOUT · ETIMEDOUT/);
  await assertAxeClean(container, 'expanded details');
  await click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  unmount();

  const failing = fakeClient({ detail: () => { throw new OpsApiError('not_found', 404, 'NOT_FOUND', ''); } });
  const again = await signedIn(failing);
  await click(byText(again.container, 'button', 'Details'));
  await settle();
  assert.match(again.container.querySelector('[role="alert"]').textContent, /no longer exists/);
  again.unmount();
});

test('retry: success requeues, announces it politely, and refreshes the list', async () => {
  const client = fakeClient();
  const { container, unmount } = await signedIn(client);
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.equal(client.calls.retry.length, 1);
  assert.equal(client.calls.retry[0].id, 'job-1');
  assert.equal(client.calls.retry[0].token, TOKEN);
  assert.match(client.calls.retry[0].key, /^[A-Za-z0-9_.:-]{8,255}$/);
  assert.equal(client.calls.list.length, 2, 'list refreshed after the retry');
  const status = $(container, '[role="status"][aria-live="polite"]');
  assert.match(status.textContent, /was requeued/);
  unmount();
});

test('retry: a double click sends one request', async () => {
  let release;
  const client = fakeClient({ retry: () => new Promise((resolve) => { release = () => resolve({ status: 'requeued', jobId: 'job-1' }); }) });
  const { container, unmount } = await signedIn(client);
  const button = byText(container, 'button', 'Retry');
  await act(async () => { button.click(); button.click(); });
  assert.equal(client.calls.retry.length, 1);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  await act(async () => release());
  await settle();
  assert.equal(client.calls.retry.length, 1);
  unmount();
});

test('retry: after a network failure the same click is replayed with the same key', async () => {
  const client = fakeClient({
    retry: (t, id, key, n) => {
      if (n === 1) throw new OpsApiError('unavailable', 0, 'NETWORK', 'Could not reach the API');
      return { status: 'duplicate', jobId: id };
    },
  });
  const { container, unmount } = await signedIn(client);
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.match($(container, '[role="status"][aria-live="polite"]').textContent, /Nothing was changed/);
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.equal(client.calls.retry.length, 2);
  assert.equal(client.calls.retry[1].key, client.calls.retry[0].key, 'unknown outcome reuses the key so the server can deduplicate');
  assert.match($(container, '[role="status"][aria-live="polite"]').textContent, /already requeued/);
  unmount();
});

test('retry: a definitive refusal discards the key, reports the server reason, and refreshes the list', async () => {
  const client = fakeClient({
    retry: (t, id, key, n) => {
      if (n === 1) throw new OpsApiError('conflict', 409, 'RETRY_IN_PROGRESS', 'A retry for this job is already running');
      return { status: 'requeued', jobId: id };
    },
  });
  const { container, unmount } = await signedIn(client);
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.match($(container, '[role="status"][aria-live="polite"]').textContent, /already running/);
  assert.equal(client.calls.list.length, 2, 'list refreshed to show the real state');
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.notEqual(client.calls.retry[1].key, client.calls.retry[0].key, 'a new decision gets a new key');
  unmount();
});

test('authorization: a server 422 for a user-action failure is shown, not retried', async () => {
  const client = fakeClient({ retry: () => { throw new OpsApiError('user_action', 422, 'USER_ACTION_REQUIRED', 'Update the customer email address on the invoice.'); } });
  const { container, unmount } = await signedIn(client);
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.match($(container, '[role="status"][aria-live="polite"]').textContent, /customer email address/);
  assert.equal(client.calls.retry.length, 1);
  unmount();
});

test('authorization: a 401 during retry signs the operator out', async () => {
  const client = fakeClient({ retry: () => { throw new OpsApiError('unauthorized', 401, 'UNAUTHORIZED', ''); } });
  const { container, unmount } = await signedIn(client);
  await click(byText(container, 'button', 'Retry'));
  await settle();
  assert.ok($(container, '#ops-token'));
  unmount();
});

test('malicious text from the server is rendered as text, never as markup', async () => {
  const client = fakeClient({ list: () => view([item({ lastError: '<img src=x onerror=alert(1)><script>boom()</script>', operationType: '<b>op</b>' })]) });
  const { container, unmount } = await signedIn(client);
  assert.equal(container.querySelectorAll('img, script, b').length, 0);
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)>/);
  unmount();
});
