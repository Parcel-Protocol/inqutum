import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describeAccessControl, permissionsFor } from '../../../shared/access-control';
import { loadAuthConfig } from '../auth/config';
import { issueSessionToken } from '../auth/session-token';
import { ChallengeReplayGuard, verifyWalletChallenge } from '../auth/wallet-challenge';
import { NETWORK_PASSPHRASE } from '../config/stellar';
import { authenticate } from '../middleware/access-control';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { sendFailure, sendSuccess } from '../types/api';

export interface AuthRouterOptions {
  enableRateLimiting?: boolean;
  networkPassphrase?: string;
  replayGuard?: ChallengeReplayGuard;
  /** Read per request so tests and dev reloads see changes. */
  env?: () => Record<string, string | undefined>;
}

/**
 * Sign-in and introspection routes. Mount under `/api` next to the invoice
 * router:
 *   POST /auth/session   exchange a wallet-signed challenge for a session token
 *   GET  /auth/me        who the server thinks you are, and what you may do
 *   GET  /auth/roles     the full role/permission table
 */
export function createAuthRouter(options: AuthRouterOptions = {}): Router {
  const router = Router();
  const env = options.env ?? (() => process.env);
  const passphrase = options.networkPassphrase ?? NETWORK_PASSPHRASE;
  const replayGuard = options.replayGuard ?? new ChallengeReplayGuard();

  const enableRateLimiting =
    options.enableRateLimiting ??
    (process.env.ENABLE_RATE_LIMITING === 'true' || process.env.NODE_ENV === 'production');

  const sessionLimits: RequestHandler[] = enableRateLimiting
    ? [
        createRateLimiter({
          windowMs: 60_000,
          max: 10,
          keyGenerator: (req) => `auth_session:${getClientIp(req)}`,
          message: 'Too many sign-in attempts. Try again shortly.',
        }),
      ]
    : [];

  router.post('/auth/session', ...sessionLimits, (req: Request, res: Response) => {
    const config = loadAuthConfig(env());
    if (!config.sessionSecret) {
      return sendFailure(
        res,
        503,
        'Wallet sessions are not configured on this server',
        'SESSION_UNAVAILABLE'
      );
    }

    const result = verifyWalletChallenge(req.body?.transaction, {
      networkPassphrase: passphrase,
      replayGuard,
    });
    if (!result.ok) {
      return sendFailure(res, 401, result.reason, 'INVALID_WALLET_PROOF', { reason: result.code });
    }

    const { token, claims } = issueSessionToken(config.sessionSecret, result.wallet, {
      ttlSeconds: config.sessionTtlSeconds,
    });
    sendSuccess(res, 200, {
      token,
      tokenType: 'Bearer',
      role: 'end_user',
      wallet: result.wallet,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    });
  });

  router.get('/auth/me', authenticate(env), (req: Request, res: Response) => {
    const actor = req.actor!;
    sendSuccess(res, 200, {
      role: actor.role,
      wallet: actor.wallet ?? null,
      permissions: permissionsFor(actor.role),
    });
  });

  router.get('/auth/roles', (_req: Request, res: Response, _next: NextFunction) => {
    sendSuccess(res, 200, describeAccessControl());
  });

  return router;
}

export default createAuthRouter;
