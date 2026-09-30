import assert from 'node:assert/strict';
import test from 'node:test';
import { QuotaManager } from '../src/domain/quota-management';

const limits = {
  invoice_create: { limit: 2, windowMs: 1_000 },
  horizon_verify: { limit: 2, windowMs: 1_000 },
  email_enqueue: { limit: 2, windowMs: 1_000 },
  import_row: { limit: 2, windowMs: 1_000 },
  search_index: { limit: 2, windowMs: 1_000 },
};

test('quota permits work within a window and blocks the next reservation', () => {
  const manager = new QuotaManager(limits);
  assert.equal(manager.reserve('invoice_create', { actor: 'wallet-a' }, 1, 0).allowed, true);
  assert.equal(manager.reserve('invoice_create', { actor: 'wallet-a' }, 1, 1).allowed, true);
  const blocked = manager.reserve('invoice_create', { actor: 'wallet-a' }, 1, 2);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(blocked.code, 'QUOTA_EXCEEDED');
    assert.equal(blocked.usage.used, 2);
    assert.equal(blocked.retryAfterSeconds, 1);
  }
});

test('quota windows reset without an operator action', () => {
  const manager = new QuotaManager(limits);
  manager.reserve('horizon_verify', { actor: 'wallet-a', resource: 'invoice-a' }, 2, 0);
  assert.equal(manager.reserve('horizon_verify', { actor: 'wallet-a', resource: 'invoice-a' }, 1, 1).allowed, false);
  assert.equal(manager.reserve('horizon_verify', { actor: 'wallet-a', resource: 'invoice-a' }, 1, 1_000).allowed, true);
});

test('maintainer overrides and explicit resets are resource-scoped and inspectable', () => {
  const manager = new QuotaManager(limits);
  manager.reserve('email_enqueue', { actor: 'wallet-a', resource: 'invoice-a' }, 2, 0);
  assert.equal(manager.reserve('email_enqueue', { actor: 'wallet-a', resource: 'invoice-a' }, 1, 1).allowed, false);
  manager.setOverride({ operation: 'email_enqueue', actor: 'wallet-a', resource: 'invoice-a', extraUnits: 1, reason: 'support incident', setBy: 'maintainer:1' }, 2);
  const allowed = manager.reserve('email_enqueue', { actor: 'wallet-a', resource: 'invoice-a' }, 1, 3);
  assert.equal(allowed.allowed, true);
  assert.equal(manager.inspect({ actor: 'wallet-a' }, 4)[0].overridden, true);
  assert.equal(manager.reset({ actor: 'wallet-a', resource: 'invoice-a' }, 'email_enqueue'), 1);
  assert.deepEqual(manager.inspect({ actor: 'wallet-a' }, 4), []);
});
