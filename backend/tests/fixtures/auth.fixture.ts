// Credentials for tests that drive the real router.
//
// Importing this module configures the auth environment (session secret and
// operator/service tokens) before any request is made; the server reads it per
// request, so import order relative to the router does not matter.
import { issueSessionToken } from '../../src/auth/session-token.ts';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
export const MAINTAINER_TOKEN = 'test-maintainer-token-0123456789abcdef';
export const SERVICE_TOKEN = 'test-service-token-0123456789abcdefgh';

process.env.AUTH_SESSION_SECRET = TEST_SESSION_SECRET;
process.env.MAINTAINER_API_TOKENS = MAINTAINER_TOKEN;
process.env.SERVICE_API_TOKENS = SERVICE_TOKEN;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Headers for a seller who has proven control of `wallet`. */
export function walletAuth(wallet: string, options: { nowMs?: number; ttlSeconds?: number } = {}) {
  const { token } = issueSessionToken(TEST_SESSION_SECRET, wallet, {
    nowMs: options.nowMs,
    ttlSeconds: options.ttlSeconds ?? 3600,
  });
  return bearer(token);
}

export const maintainerAuth = () => bearer(MAINTAINER_TOKEN);
export const serviceAuth = () => bearer(SERVICE_TOKEN);
