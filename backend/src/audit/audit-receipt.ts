/**
 * Signed audit receipts for administrative changes (#428).
 *
 * A receipt is a detached statement that one audit event was recorded: who
 * acted, what changed, when, and digests of the before/after state. It is
 * signed with HMAC-SHA256 under AUDIT_RECEIPT_SIGNING_KEY. Only digests of the
 * state are signed, so a receipt never carries the configuration values or the
 * free-text reason.
 *
 * Format: `iqr.v1.<base64url(claims JSON)>.<base64url(HMAC-SHA256)>`
 *
 *  - The version prefix fixes the algorithm; there is no `alg` header to trust.
 *  - The signature is checked with a constant-time compare before the claims
 *    are parsed.
 *  - Verification with an event checks that the receipt describes that exact
 *    event (id, hash, actor, scope, state digests).
 *
 * Symmetric HMAC means verifiers need the same key as the signer. Third-party
 * verification would need an asymmetric scheme; see docs in NOTES for the slice.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalize } from '../security/canonical-serialization';
import type { AuditEvent } from './audit-service';

export const RECEIPT_KEY_ENV = 'AUDIT_RECEIPT_SIGNING_KEY';
export const MIN_RECEIPT_KEY_LENGTH = 32;
const PREFIX = 'iqr.v1';
const MAX_RECEIPT_LENGTH = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface AuditReceiptClaims {
  typ: 'iqr';
  v: 1;
  eventId: string;
  eventHash: string | null;
  timestamp: string;
  action: string;
  actorType: string;
  actorId: string;
  entityType: string;
  entityId: string;
  /** SHA-256 of the canonical before-state, or null when the change had none. */
  beforeDigest: string | null;
  afterDigest: string | null;
}

export type AuditReceiptVerification =
  | { valid: true; claims: AuditReceiptClaims }
  | { valid: false; reason: 'malformed' | 'signature' | 'mismatch' };

export class AuditReceiptError extends Error {
  constructor(public readonly code: 'RECEIPT_KEY_INVALID', message: string) {
    super(message);
    this.name = 'AuditReceiptError';
  }
}

/** Digest of a state snapshot, or null for "no state". */
export function stateDigest(state: Record<string, unknown> | null | undefined): string | null {
  if (state === null || state === undefined) return null;
  return createHash('sha256').update(canonicalize(state)).digest('hex');
}

/**
 * The receipt key from the environment: null when unset (the caller decides
 * whether that is acceptable), an error when set but too short.
 */
export function receiptKeyFromEnv(env: Record<string, string | undefined>): string | null {
  const key = env[RECEIPT_KEY_ENV];
  if (!key) return null;
  if (key.length < MIN_RECEIPT_KEY_LENGTH) {
    throw new AuditReceiptError('RECEIPT_KEY_INVALID', `${RECEIPT_KEY_ENV} must be at least ${MIN_RECEIPT_KEY_LENGTH} characters`);
  }
  return key;
}

function claimsFor(event: AuditEvent): AuditReceiptClaims {
  return {
    typ: 'iqr',
    v: 1,
    eventId: event.id,
    eventHash: event.hash ?? null,
    timestamp: event.timestamp,
    action: event.action,
    actorType: event.actor.type,
    actorId: event.actor.id,
    entityType: event.scope.entityType,
    entityId: event.scope.entityId,
    beforeDigest: stateDigest(event.beforeState),
    afterDigest: stateDigest(event.afterState),
  };
}

function macOver(body: string, key: string): string {
  return createHmac('sha256', key).update(`${PREFIX}.${body}`).digest('base64url');
}

export function signAuditReceipt(event: AuditEvent, key: string): string {
  if (!key || key.length < MIN_RECEIPT_KEY_LENGTH) {
    throw new AuditReceiptError('RECEIPT_KEY_INVALID', `${RECEIPT_KEY_ENV} must be at least ${MIN_RECEIPT_KEY_LENGTH} characters`);
  }
  const body = Buffer.from(canonicalize(claimsFor(event)), 'utf8').toString('base64url');
  return `${PREFIX}.${body}.${macOver(body, key)}`;
}

function isClaims(value: unknown): value is AuditReceiptClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  const strings = ['eventId', 'timestamp', 'action', 'actorType', 'actorId', 'entityType', 'entityId'];
  return (
    c.typ === 'iqr' &&
    c.v === 1 &&
    strings.every((k) => typeof c[k] === 'string') &&
    (c.eventHash === null || typeof c.eventHash === 'string') &&
    (c.beforeDigest === null || typeof c.beforeDigest === 'string') &&
    (c.afterDigest === null || typeof c.afterDigest === 'string')
  );
}

function matches(claims: AuditReceiptClaims, event: AuditEvent): boolean {
  const expected = claimsFor(event);
  return (Object.keys(expected) as (keyof AuditReceiptClaims)[]).every((k) => claims[k] === expected[k]);
}

export function verifyAuditReceipt(token: string, key: string, event?: AuditEvent): AuditReceiptVerification {
  if (typeof token !== 'string' || token.length > MAX_RECEIPT_LENGTH || !token.startsWith(`${PREFIX}.`)) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.slice(PREFIX.length + 1).split('.');
  if (parts.length !== 2 || !parts.every((p) => BASE64URL.test(p))) {
    return { valid: false, reason: 'malformed' };
  }
  const [body, given] = parts;
  const expected = Buffer.from(macOver(body, key), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'signature' };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!isClaims(claims)) return { valid: false, reason: 'malformed' };
  if (event && !matches(claims, event)) return { valid: false, reason: 'mismatch' };
  return { valid: true, claims };
}

/**
 * Returns the receipt only to the actor the change is attributed to. Any other
 * caller gets null, so a receipt for one maintainer's change is never disclosed
 * to another party.
 */
export function disclosedReceiptFor(receipt: string | null, event: AuditEvent, requesterId: string): string | null {
  return receipt !== null && requesterId !== '' && event.actor.id === requesterId ? receipt : null;
}
