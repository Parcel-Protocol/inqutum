/**
 * User-facing service status (#381): parsing untrusted API data and deciding
 * what, if anything, to show.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseServiceStatus,
  describeServiceStatus,
  capabilityBlocked,
  formatRetryAfter,
} = require('../lib/service-status.js');

const feature = (over = {}) => ({
  capability: 'payment.verify',
  label: 'Payment confirmation',
  state: 'operational',
  code: null,
  message: null,
  retryAfterSeconds: null,
  ...over,
});
const payload = (features, over = {}) => ({ overall: 'operational', summary: 'ok', features, ...over });

test('normal: a healthy status parses and produces no notice', () => {
  const status = parseServiceStatus(payload([feature()]));
  assert.equal(status.overall, 'operational');
  assert.equal(status.features.length, 1);
  assert.equal(describeServiceStatus(status), null);
});

test('failure: an unavailable feature yields an unavailable notice with its message and retry', () => {
  const status = parseServiceStatus(
    payload(
      [feature({ state: 'unavailable', message: 'Payments cannot be confirmed right now.', retryAfterSeconds: 15 })],
      { overall: 'unavailable', summary: 'Some features are temporarily unavailable.' }
    )
  );
  const notice = describeServiceStatus(status);
  assert.equal(notice.severity, 'unavailable');
  assert.equal(notice.title, 'Some features are temporarily unavailable');
  assert.equal(notice.retryAfterSeconds, 15);
  assert.deepEqual(notice.issues, [
    { capability: 'payment.verify', label: 'Payment confirmation', state: 'unavailable', message: 'Payments cannot be confirmed right now.' },
  ]);
});

test('degraded only: severity is degraded; unavailable items sort first and win severity', () => {
  const degraded = parseServiceStatus(payload([feature({ state: 'degraded', message: 'slow' })], { overall: 'degraded' }));
  assert.equal(describeServiceStatus(degraded).severity, 'degraded');

  const mixed = parseServiceStatus(
    payload([
      feature({ capability: 'a', label: 'A', state: 'degraded', message: 'slow', retryAfterSeconds: 10 }),
      feature({ capability: 'b', label: 'B', state: 'unavailable', message: 'down', retryAfterSeconds: 30 }),
    ])
  );
  const notice = describeServiceStatus(mixed);
  assert.equal(notice.severity, 'unavailable');
  assert.deepEqual(notice.issues.map((i) => i.capability), ['b', 'a']);
  assert.equal(notice.retryAfterSeconds, 30, 'uses the longest wait');
});

test('unknown state shows nothing: no news is not an outage', () => {
  const status = parseServiceStatus(payload([feature({ state: 'unknown' })], { overall: 'unknown' }));
  assert.equal(describeServiceStatus(status), null);
  assert.equal(describeServiceStatus(null), null);
});

test('authorization boundary: malformed or hostile payloads are rejected or sanitised', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { overall: 'nope', features: [] }, { overall: 'operational' }, { overall: 'operational', features: 'x' }]) {
    assert.equal(parseServiceStatus(bad), null);
  }
  const status = parseServiceStatus(
    payload([
      feature({ state: 'exploded' }),
      null,
      'string',
      feature({ label: '', state: 'degraded' }),
      feature({ capability: '', state: 'degraded' }),
      feature({ capability: 'x', label: 'X', state: 'unavailable', message: `<img src=x onerror=alert(1)>\u0000${'y'.repeat(1000)}`, retryAfterSeconds: 999999 }),
    ])
  );
  assert.equal(status.features.length, 1, 'only the valid feature survives');
  const [f] = status.features;
  assert.ok(f.message.length <= 300);
  assert.ok(!f.message.includes('\u0000'));
  assert.equal(f.retryAfterSeconds, 3600, 'retry hint is capped');
});

test('retry hints: only positive finite numbers are kept', () => {
  const status = parseServiceStatus(
    payload([
      feature({ capability: 'a', label: 'A', state: 'degraded', retryAfterSeconds: -5 }),
      feature({ capability: 'b', label: 'B', state: 'degraded', retryAfterSeconds: Number.NaN }),
      feature({ capability: 'c', label: 'C', state: 'degraded', retryAfterSeconds: '30' }),
      feature({ capability: 'd', label: 'D', state: 'degraded', retryAfterSeconds: 12.7 }),
    ])
  );
  assert.deepEqual(status.features.map((f) => f.retryAfterSeconds), [null, null, null, 12]);
  assert.equal(describeServiceStatus(status).retryAfterSeconds, 12);
});

test('feature list is bounded and stale is carried through', () => {
  const many = Array.from({ length: 50 }, (_, i) => feature({ capability: `c${i}`, label: `L${i}`, state: 'degraded' }));
  const status = parseServiceStatus(payload(many, { stale: true }));
  assert.equal(status.features.length, 20);
  assert.equal(status.stale, true);
  assert.equal(describeServiceStatus(status).stale, true);
  assert.equal(parseServiceStatus(payload([], { stale: 'yes' })).stale, false);
});

test('capabilityBlocked: only an unavailable feature blocks, and it explains why', () => {
  const status = parseServiceStatus(
    payload([
      feature({ capability: 'export.create', label: 'Data export', state: 'unavailable', message: 'Exports are temporarily unavailable.' }),
      feature({ capability: 'payment.verify', state: 'degraded', message: 'delayed' }),
    ])
  );
  assert.deepEqual(capabilityBlocked(status, 'export.create'), { blocked: true, message: 'Exports are temporarily unavailable.' });
  assert.deepEqual(capabilityBlocked(status, 'payment.verify'), { blocked: false, message: '' });
  assert.deepEqual(capabilityBlocked(status, 'missing'), { blocked: false, message: '' });
  assert.deepEqual(capabilityBlocked(null, 'export.create'), { blocked: false, message: '' });
});

test('formatRetryAfter: seconds, minutes, and nothing for junk', () => {
  assert.equal(formatRetryAfter(1), 'about 1 second');
  assert.equal(formatRetryAfter(30), 'about 30 seconds');
  assert.equal(formatRetryAfter(60), 'about 1 minute');
  assert.equal(formatRetryAfter(61), 'about 2 minutes');
  for (const junk of [0, -1, Number.NaN, null, undefined]) assert.equal(formatRetryAfter(junk), '');
});
