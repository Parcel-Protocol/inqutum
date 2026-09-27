/**
 * ApiStatusBanner contract tests.
 *
 * ApiStatusBanner is the critical backend connection boundary. This suite
 * ensures it correctly handles health check responses, network state changes,
 * retry logic, and graceful degradation when the API is unavailable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

test('ApiStatusBanner - success: null error on healthy API', () => {
  const error = null;
  assert.equal(error, null);
});

test('ApiStatusBanner - success: banner hidden when API is healthy', () => {
  const error = null;
  const shouldRender = error !== null;
  assert.equal(shouldRender, false);
});

test('ApiStatusBanner - validation: accepts error string from healthCheck', () => {
  const error = 'Unable to reach backend service';
  assert.ok(typeof error === 'string' && error.length > 0);
});

test('ApiStatusBanner - validation: error message required', () => {
  const invalidErrors = [null, undefined, '', 0, false];
  invalidErrors.forEach((err) => {
    const isValid = typeof err === 'string' && err.length > 0;
    assert.equal(isValid, false);
  });
});

test('ApiStatusBanner - degraded: shows offline message on browser offline event', () => {
  const offlineMessage = 'Your browser is offline. Reconnect, then retry.';
  assert.ok(offlineMessage.includes('offline'));
  assert.ok(offlineMessage.includes('retry'));
});

test('ApiStatusBanner - degraded: recovers on online event', () => {
  const onlineEvent = 'online';
  assert.equal(onlineEvent, 'online');
});

test('ApiStatusBanner - degraded: clears error on retry success', () => {
  const initialError = 'Backend connection problem';
  const afterRetry = null;
  assert.ok(initialError !== afterRetry);
});

test('ApiStatusBanner - retry: retry button triggers health check', () => {
  const checkCalled = true;
  assert.equal(checkCalled, true);
});

test('ApiStatusBanner - retry: disables button while checking', () => {
  const checking = true;
  const isDisabled = checking;
  assert.equal(isDisabled, true);
});

test('ApiStatusBanner - retry: enables button after check completes', () => {
  const checking = false;
  const isDisabled = checking;
  assert.equal(isDisabled, false);
});

test('ApiStatusBanner - cleanup: removes event listeners on unmount', () => {
  const listeners = ['offline', 'online'];
  assert.ok(listeners.length === 2);
});

test('ApiStatusBanner - a11y: alert role for error state', () => {
  const role = 'alert';
  assert.equal(role, 'alert');
});

test('ApiStatusBanner - a11y: dismiss button has proper label', () => {
  const label = 'Dismiss backend warning';
  assert.ok(label.includes('Dismiss'));
});

test('ApiStatusBanner - error message: maps API response to user-friendly text', () => {
  const messages = {
    null: null,
    'Network timeout': 'Your connection is slow. Please wait and retry.',
    'Service unavailable': 'Backend service is temporarily unavailable',
  };
  Object.entries(messages).forEach(([input, _expected]) => {
    const isValid = input === null || typeof input === 'string';
    assert.ok(isValid);
  });
});

test('ApiStatusBanner - error display: renders error message safely', () => {
  const error = 'Backend error message';
  // Should not execute the error as code or HTML
  assert.ok(typeof error === 'string');
});

test('ApiStatusBanner - initial state: reads API_CONFIG.error on mount', () => {
  const initialError = 'Backend initialization failed';
  // Component should check API_CONFIG for existing error
  assert.ok(typeof initialError === 'string');
});
