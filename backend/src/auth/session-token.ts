import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { SESSION_TOKEN_PREFIX } from '../../../shared/wallet-auth';

/**
 * A wallet session: proof that `sub` (a Stellar account) signed a sign-in
 * challenge recently. Stateless, so any instance holding the secret can verify
 * it, and it needs no session table. The price of statelessness is that a token
 * cannot be revoked before `exp`; that is why the lifetime is short.
 */
export interface SessionClaims {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

const b64 = (input: Buffer | string) => Buffer.from(input).toString('base64url');

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function issueSessionToken(
  secret: string,
  wallet: string,
  options: { nowMs?: number; ttlSeconds: number }
): { token: string; claims: SessionClaims } {
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const claims: SessionClaims = { sub: wallet, iat, exp: iat + options.ttlSeconds, jti: randomUUID() };
  const body = `${SESSION_TOKEN_PREFIX}.${b64(JSON.stringify(claims))}`;
  return { token: `${body}.${b64(sign(secret, body))}`, claims };
}

/** Returns the claims of a genuine, unexpired token, or null for anything else. */
export function verifySessionToken(
  secret: string,
  token: string,
  nowMs: number = Date.now()
): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) return null;

  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(secret, body);
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const valid =
    typeof claims?.sub === 'string' &&
    StrKey.isValidEd25519PublicKey(claims.sub) &&
    Number.isInteger(claims.iat) &&
    Number.isInteger(claims.exp) &&
    claims.exp > Math.floor(nowMs / 1000);
  return valid ? claims : null;
}
