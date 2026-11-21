/**
 * Signed audit receipts for administrative changes (#428).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminConfigError, AdminConfigService } from '../src/config/admin-config';
import { featureFlagOverrides } from '../src/config/feature-flags';
import { MemoryAuditStore, type AuditEvent } from '../src/audit/audit-service';
import {
  RECEIPT_KEY_ENV,
  disclosedReceiptFor,
  receiptKeyFromEnv,
  signAuditReceipt,
  verifyAuditReceipt,
} from '../src/audit/audit-receipt';

const KEY = 'audit-receipt-test-signing-key-0123456789';
const OTHER_KEY = 'audit-receipt-test-OTHER-key-9876543210';
const FLAG = 'paymentAmountTolerance';
const REASON = 'Incident 42: disable tolerance while Horizon rounding is investigated';
const PROD_ENV = { NODE_ENV: 'production', [RECEIPT_KEY_ENV]: KEY };

/** A private override layer so service tests never touch the process flags. */
function localOverrides() {
  const map = new Map<string, boolean>();
  return {
    get: (flag: string) => map.get(flag),
    set: (flag: string, value: boolean | null) => (value === null ? map.delete(flag) : map.set(flag, value)),
  } as typeof featureFlagOverrides;
}

function sampleEvent(): AuditEvent {
  return new MemoryAuditStore(10).recordEvent({
    action: 'CONFIG_CHANGED',
    actor: { type: 'maintainer', id: 'maintainer-alice' },
    scope: { entityType: 'config', entityId: `featureFlags.${FLAG}` },
    reason: REASON,
    beforeState: { enabled: false, override: null, configVersion: 0 },
    afterState: { enabled: true, override: true, configVersion: 1 },
  });
}

function serviceWith(env: Record<string, string | undefined>, recordAudit?: (e: any) => AuditEvent) {
  const store = new MemoryAuditStore(50);
  const overrides = localOverrides();
  const service = new AdminConfigService({
    overrides,
    env,
    recordAudit: recordAudit ?? ((e) => store.recordEvent(e)),
  });
  return { service, store, overrides };
}

const change = (service: AdminConfigService) =>
  service.setFeatureFlag({
    flag: FLAG,
    enabled: true,
    reason: REASON,
    expectedVersion: service.snapshot().version,
    actorId: 'maintainer-alice',
    capabilityId: 'cap-1',
    correlationId: 'corr-1',
  });

function rejectsWith(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AdminConfigError);
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, status);
    return true;
  });
}

/** Rewrites the claims of a receipt and keeps the old signature, which must fail. */
function withClaims(token: string, patch: Record<string, unknown>): string {
  const [prefix, version, body, sig] = token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...claims, ...patch }), 'utf8').toString('base64url');
  return [prefix, version, forged, sig].join('.');
}

describe('audit receipts — signing and verification (#428)', () => {
  it('signs a receipt that verifies against the event it describes (normal path)', () => {
    const event = sampleEvent();
    const receipt = signAuditReceipt(event, KEY);
    const result = verifyAuditReceipt(receipt, KEY, event);
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.claims.eventId, event.id);
      assert.equal(result.claims.action, 'CONFIG_CHANGED');
      assert.equal(result.claims.actorId, 'maintainer-alice');
      assert.equal(result.claims.entityId, `featureFlags.${FLAG}`);
      assert.match(result.claims.beforeDigest ?? '', /^[0-9a-f]{64}$/);
      assert.match(result.claims.afterDigest ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(result.claims.beforeDigest, result.claims.afterDigest);
    }
  });

  it('binds before and after state by digest, not by value', () => {
    const receipt = signAuditReceipt(sampleEvent(), KEY);
    const payload = Buffer.from(receipt.split('.')[2], 'base64url').toString('utf8');
    assert.equal(payload.includes(REASON), false);
    assert.equal(payload.includes('"enabled"'), false);
  });

  it('rejects a tampered receipt payload', () => {
    const event = sampleEvent();
    const forged = withClaims(signAuditReceipt(event, KEY), { actorId: 'maintainer-mallory' });
    assert.deepEqual(verifyAuditReceipt(forged, KEY, event), { valid: false, reason: 'signature' });
  });

  it('rejects a receipt verified with a different key', () => {
    const receipt = signAuditReceipt(sampleEvent(), KEY);
    assert.deepEqual(verifyAuditReceipt(receipt, OTHER_KEY), { valid: false, reason: 'signature' });
  });

  it('rejects a valid receipt that does not match the event it is presented with', () => {
    const event = sampleEvent();
    const receipt = signAuditReceipt(event, KEY);
    const altered = { ...event, actor: { ...event.actor, id: 'maintainer-mallory' } };
    assert.deepEqual(verifyAuditReceipt(receipt, KEY, altered), { valid: false, reason: 'mismatch' });
  });

  it('rejects malformed input without throwing', () => {
    assert.deepEqual(verifyAuditReceipt('not-a-receipt', KEY), { valid: false, reason: 'malformed' });
    assert.deepEqual(verifyAuditReceipt('iqr.v1.abc', KEY), { valid: false, reason: 'malformed' });
    assert.deepEqual(verifyAuditReceipt('', KEY), { valid: false, reason: 'malformed' });
  });
});

describe('audit receipts — key source and fail-closed behaviour (#428)', () => {
  it('reads no key when the variable is unset or empty', () => {
    assert.equal(receiptKeyFromEnv({}), null);
    assert.equal(receiptKeyFromEnv({ [RECEIPT_KEY_ENV]: '' }), null);
  });

  it('refuses a key shorter than 32 characters', () => {
    assert.throws(() => receiptKeyFromEnv({ [RECEIPT_KEY_ENV]: 'short' }), /at least 32/);
  });

  it('refuses an admin change in production when the key is missing, and applies nothing', () => {
    const { service, store, overrides } = serviceWith({ NODE_ENV: 'production' });
    rejectsWith(() => change(service), 'CONFIG_AUDIT_UNAVAILABLE', 503);
    assert.equal(service.snapshot().version, 0);
    assert.equal(overrides.get(FLAG), undefined);
    assert.equal(store.size(), 0, 'no evidence is written for a change refused before recording');
  });

  it('refuses an admin change in production when the key is too short', () => {
    const { service, overrides } = serviceWith({ NODE_ENV: 'production', [RECEIPT_KEY_ENV]: 'short' });
    rejectsWith(() => change(service), 'CONFIG_AUDIT_UNAVAILABLE', 503);
    assert.equal(overrides.get(FLAG), undefined);
  });

  it('applies a non-production change without a key and returns no receipt (dev/test only)', () => {
    const { service } = serviceWith({ NODE_ENV: 'test' });
    const result = change(service);
    assert.equal(result.changed, true);
    assert.equal(result.receipt, null);
  });
});

describe('audit receipts — admin change flow (#428)', () => {

  it('returns a receipt for an applied admin change that verifies against its audit event', () => {
    const { service, store } = serviceWith(PROD_ENV);
    const result = change(service);
    assert.equal(result.changed, true);
    assert.equal(typeof result.receipt, 'string');
    const event = store.queryEvents().events[0];
    assert.equal(event.id, result.auditEventId);
    const verified = verifyAuditReceipt(result.receipt as string, KEY, event);
    assert.equal(verified.valid, true);
  });

  it('failure path: when evidence cannot be written the change is not applied and no receipt is returned', () => {
    const { service, overrides } = serviceWith(PROD_ENV, () => {
      throw new Error('ledger unavailable');
    });
    rejectsWith(() => change(service), 'CONFIG_AUDIT_UNAVAILABLE', 503);
    assert.equal(overrides.get(FLAG), undefined);
    assert.equal(service.snapshot().version, 0);
  });

  it('unauthorized caller does not receive a receipt for another actor\'s change', () => {
    const { service, store } = serviceWith(PROD_ENV);
    const result = change(service);
    const event = store.queryEvents().events[0];
    assert.equal(disclosedReceiptFor(result.receipt, event, 'maintainer-mallory'), null);
    assert.equal(disclosedReceiptFor(result.receipt, event, 'maintainer-alice'), result.receipt);
  });
});
