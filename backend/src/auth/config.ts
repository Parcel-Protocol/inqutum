import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_SESSION_TTL_SECONDS } from '../../../shared/wallet-auth';

type Env = Record<string, string | undefined>;

/** API tokens shorter than this are refused: they are guessable, not secret. */
export const MIN_API_TOKEN_LENGTH = 24;

export interface AuthConfig {
  /** HMAC key for wallet session tokens; null means session issuance is unavailable. */
  sessionSecret: string | null;
  sessionTtlSeconds: number;
  /** SHA-256 digests of the configured operator / service tokens. */
  maintainerTokenDigests: Buffer[];
  serviceTokenDigests: Buffer[];
}

const digest = (token: string) => createHash('sha256').update(token).digest();

function parseTokens(raw: string | undefined, label: string): Buffer[] {
  return (raw || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => {
      if (token.length >= MIN_API_TOKEN_LENGTH) return true;
      console.warn(`[auth] ignoring a ${label} token shorter than ${MIN_API_TOKEN_LENGTH} characters`);
      return false;
    })
    .map(digest);
}

// Outside production a missing secret is replaced by a random one for the life
// of the process, so a laptop or CI run needs no setup. It is never reused
// across restarts and never applied in production, where a missing secret means
// wallet sessions are simply unavailable rather than signed with a guessable key.
let ephemeralSecret: string | null = null;

export function loadAuthConfig(env: Env = process.env): AuthConfig {
  let sessionSecret = env.AUTH_SESSION_SECRET?.trim() || null;
  if (sessionSecret && sessionSecret.length < 32) {
    console.warn('[auth] AUTH_SESSION_SECRET is shorter than 32 characters and was ignored');
    sessionSecret = null;
  }
  if (!sessionSecret && env.NODE_ENV !== 'production') {
    ephemeralSecret ??= randomBytes(32).toString('hex');
    sessionSecret = ephemeralSecret;
  }

  const ttl = Number(env.AUTH_SESSION_TTL_SECONDS);
  return {
    sessionSecret,
    sessionTtlSeconds: Number.isInteger(ttl) && ttl >= 60 && ttl <= 86_400 ? ttl : DEFAULT_SESSION_TTL_SECONDS,
    maintainerTokenDigests: parseTokens(env.MAINTAINER_API_TOKENS, 'MAINTAINER_API_TOKENS'),
    serviceTokenDigests: parseTokens(env.SERVICE_API_TOKENS, 'SERVICE_API_TOKENS'),
  };
}

export const digestToken = digest;
