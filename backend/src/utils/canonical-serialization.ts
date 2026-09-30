/** Versioned canonical payloads for signatures, hashes and external references. */
export const CANONICAL_SERIALIZATION_VERSION = 'inqutum.canonical.v1';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function decimal(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  return `${negative && normalizedWhole !== '0' ? '-' : ''}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

function normalizedString(key: string, value: string): string {
  const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (key === 'assetCode' || key === 'sellerPublicKey' || key === 'payerPublicKey') return text.toUpperCase();
  if (key === 'txHash' || key === 'invoiceId') return text.toLowerCase();
  if (key === 'network') return text.toLowerCase();
  if (key === 'amount') return decimal(text);
  return text;
}

/**
 * Recursively sorts object keys and normalizes protocol scalars.  Arrays retain
 * their order: order in an array is data, while object property order is not.
 */
export function canonicalize(value: JsonValue, key = ''): JsonValue {
  if (typeof value === 'string') return normalizedString(key, value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical payload cannot contain a non-finite number');
    return key === 'amount' ? decimal(String(value)) : value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const out: { [key: string]: JsonValue } = {};
  for (const objectKey of Object.keys(value).sort()) out[objectKey] = canonicalize(value[objectKey], objectKey);
  return out;
}

/** Stable, whitespace-free JSON suitable as a signing/hash input. */
export function canonicalSerialize(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

/** Domain separation prevents a valid signature from being replayed as another action. */
export function canonicalSignedMessage(action: string, payload: JsonValue): string {
  return `${CANONICAL_SERIALIZATION_VERSION}:${normalizedString('action', action)}:${canonicalSerialize(payload)}`;
}

export function canonicalCancelMessage(invoiceId: string, sellerPublicKey: string): string {
  return canonicalSignedMessage('cancel-invoice', { invoiceId, sellerPublicKey });
}
