/**
 * A fresh key for one logical write.
 *
 * The API treats a repeated `Idempotency-Key` as "the same attempt again" and
 * answers with the first attempt's result instead of running it twice
 * (docs/IDEMPOTENCY.md). So a key must be new for each thing the user intends
 * and reused only when the *same* request is replayed, which is what the sign-in
 * retry in lib/auth-session.ts does by resending the original config.
 */
export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  // randomUUID exists only in secure contexts; fall back so a plain-http dev
  // host still gets a valid key.
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10)]
    .map((part) => part.join(''))
    .join('-');
}

/** Same pattern the server accepts: 8 to 255 URL-safe characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;
