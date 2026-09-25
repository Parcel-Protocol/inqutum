const test = require('node:test');
const assert = require('node:assert/strict');
const { IDEMPOTENCY_KEY_PATTERN, newIdempotencyKey } = require('../lib/idempotency-key.ts');

test('a key is accepted by the pattern the server enforces', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(newIdempotencyKey(), IDEMPOTENCY_KEY_PATTERN);
  }
});

test('every logical write gets a new key', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
  assert.equal(keys.size, 200);
});

test('falls back to getRandomValues where randomUUID is unavailable (plain-http hosts)', () => {
  const original = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const key = newIdempotencyKey();
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(key, IDEMPOTENCY_KEY_PATTERN);
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
  }
});
