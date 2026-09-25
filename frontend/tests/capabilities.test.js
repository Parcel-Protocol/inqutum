const test = require('node:test');
const assert = require('node:assert/strict');
const { canDo, roleForSession } = require('../lib/capabilities');
const { PERMISSIONS, ROLES, can } = require('../../shared/access-control.ts');

const OWNER = 'G' + 'A'.repeat(55);
const OTHER = 'G' + 'B'.repeat(55);

test('a visitor with no connected wallet is an anonymous payer', () => {
  assert.equal(roleForSession(null), 'anonymous');
  assert.equal(roleForSession({ connected: false, publicKey: OWNER }), 'anonymous');
  assert.equal(roleForSession({ connected: true, publicKey: null }), 'anonymous');
  assert.equal(roleForSession({ connected: true, publicKey: OWNER }), 'end_user');
});

test('the UI grants exactly what the shared table grants for unscoped permissions', () => {
  for (const role of ROLES) {
    for (const permission of ['lifecycle:read', 'invoice:read', 'invoice:verify', 'monitor:read']) {
      assert.equal(canDo(role, permission), can(role, permission), `${role} ${permission}`);
    }
  }
});

test('an end user may cancel only their own invoice', () => {
  assert.equal(canDo('end_user', 'invoice:cancel', { wallet: OWNER, sellerPublicKey: OWNER }), true);
  assert.equal(canDo('end_user', 'invoice:cancel', { wallet: OTHER, sellerPublicKey: OWNER }), false);
  assert.equal(canDo('end_user', 'invoice:cancel', { wallet: null, sellerPublicKey: OWNER }), false);
  assert.equal(canDo('end_user', 'invoice:cancel', {}), false);
});

test('an anonymous visitor is never offered a seller action, even on an invoice with no owner', () => {
  for (const permission of ['invoice:create', 'invoice:list', 'invoice:stats', 'invoice:cancel', 'invoice:audit']) {
    assert.equal(canDo('anonymous', permission, { wallet: null, sellerPublicKey: undefined }), false, permission);
  }
});

test('an unknown role can do nothing', () => {
  for (const permission of PERMISSIONS) assert.equal(canDo('root', permission), false);
});
