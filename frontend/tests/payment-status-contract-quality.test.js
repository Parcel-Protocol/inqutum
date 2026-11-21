const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS_DISPLAY,
  KNOWN_STATUSES,
  getStatusDisplayInfo,
  getStatusAccessibilityAttrs,
  shouldShowExplorerLink,
} = require('../lib/payment-status-contract');

// ---------------------------------------------------------------- getStatusDisplayInfo edge cases

test('getStatusDisplayInfo trims whitespace before lookup', () => {
  const r = getStatusDisplayInfo('  PAID  ');
  assert.equal(r.isUnknown, false);
  assert.equal(r.title, STATUS_DISPLAY.PAID.title);
});

test('getStatusDisplayInfo handles empty string as unknown', () => {
  const r = getStatusDisplayInfo('');
  assert.equal(r.isUnknown, true);
  assert.equal(r.title, STATUS_DISPLAY.PENDING.title);
});

test('getStatusDisplayInfo returns new object (not shared reference)', () => {
  const r1 = getStatusDisplayInfo('PAID');
  const r2 = getStatusDisplayInfo('PAID');
  assert.notStrictEqual(r1, r2);
});

test('all known statuses return non-null title', () => {
  for (const status of KNOWN_STATUSES) {
    const r = getStatusDisplayInfo(status);
    assert.ok(typeof r.title === 'string' && r.title.length > 0, `${status} title must be non-empty`);
  }
});

test('all known statuses return a valid icon name', () => {
  for (const status of KNOWN_STATUSES) {
    const r = getStatusDisplayInfo(status);
    assert.ok(typeof r.icon === 'string' && r.icon.length > 0, `${status} icon must be non-empty`);
  }
});

test('all known statuses return a text-* color class', () => {
  for (const status of KNOWN_STATUSES) {
    const r = getStatusDisplayInfo(status);
    assert.ok(r.color.startsWith('text-'), `${status} color must start with text-`);
  }
});

test('terminal statuses (EXPIRED, CANCELLED) have non-null descriptions', () => {
  for (const status of ['EXPIRED', 'CANCELLED']) {
    const r = getStatusDisplayInfo(status);
    assert.ok(typeof r.description === 'string' && r.description.length > 0,
      `${status} should have a description`);
  }
});

test('active statuses (PAID, PENDING) have null description in STATUS_DISPLAY', () => {
  assert.equal(STATUS_DISPLAY.PAID.description, null);
  assert.equal(STATUS_DISPLAY.PENDING.description, null);
});

// ---------------------------------------------------------------- getStatusAccessibilityAttrs edge cases

test('compact=false returns exactly three ARIA attributes', () => {
  const attrs = getStatusAccessibilityAttrs(false);
  const keys = Object.keys(attrs);
  assert.equal(keys.length, 3);
  assert.ok(keys.includes('role'));
  assert.ok(keys.includes('aria-live'));
  assert.ok(keys.includes('aria-atomic'));
});

test('aria-live value is polite (not assertive)', () => {
  const attrs = getStatusAccessibilityAttrs(false);
  assert.equal(attrs['aria-live'], 'polite');
});

test('aria-atomic value is the string "true"', () => {
  const attrs = getStatusAccessibilityAttrs(false);
  assert.equal(attrs['aria-atomic'], 'true');
});

test('compact=true returns no aria-live (decorative context)', () => {
  const attrs = getStatusAccessibilityAttrs(true);
  assert.ok(!('aria-live' in attrs));
});

// ---------------------------------------------------------------- shouldShowExplorerLink edge cases

test('shows explorer link for EXPIRED status with txHash', () => {
  assert.equal(shouldShowExplorerLink('EXPIRED', 'a'.repeat(64)), true);
});

test('shows explorer link for CANCELLED status with txHash', () => {
  assert.equal(shouldShowExplorerLink('CANCELLED', 'a'.repeat(64)), true);
});

test('hides explorer link for whitespace-only txHash', () => {
  assert.equal(shouldShowExplorerLink('PAID', '   '), false);
});

test('hides explorer link when txHash is a boolean', () => {
  assert.equal(shouldShowExplorerLink('PAID', true), false);
});

test('hides explorer link when txHash is a number', () => {
  assert.equal(shouldShowExplorerLink('PAID', 1234), false);
});

// ---------------------------------------------------------------- STATUS_DISPLAY contract

test('STATUS_DISPLAY has exactly four entries', () => {
  assert.equal(Object.keys(STATUS_DISPLAY).length, 4);
});

test('PAID icon is check-circle', () => {
  assert.equal(STATUS_DISPLAY.PAID.icon, 'check-circle');
});

test('PENDING icon is clock', () => {
  assert.equal(STATUS_DISPLAY.PENDING.icon, 'clock');
});

test('EXPIRED and CANCELLED share the x-circle icon', () => {
  assert.equal(STATUS_DISPLAY.EXPIRED.icon, 'x-circle');
  assert.equal(STATUS_DISPLAY.CANCELLED.icon, 'x-circle');
});
