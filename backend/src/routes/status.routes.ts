import { Router } from 'express';
import {
  runDependencyChecks,
  type DegradationReport,
  type DependencyId,
  type DependencyProbe,
} from '../ops/dependency-degradation';
import { buildUserStatus, unknownUserStatus, type UserStatus } from '../ops/user-status';

export interface StatusRouterOptions {
  /** Probes per dependency. Dependencies without one report `unknown`. */
  probes?: Partial<Record<DependencyId, DependencyProbe>>;
  /** How long a computed status is reused. Defaults to 10 s. */
  ttlMs?: number;
  /** Per-probe timeout. Defaults to 5 s. */
  probeTimeoutMs?: number;
  now?: () => Date;
  /** Test seam: replaces the probe runner. */
  runChecks?: (probes: StatusRouterOptions['probes']) => Promise<DegradationReport>;
}

export const DEFAULT_STATUS_TTL_MS = 10_000;

/**
 * Public, unauthenticated status for end users (#381). Mount under `/api`.
 *
 *   GET /status   -> 200 { success, data: UserStatus }
 *
 * Always answers 200: a status page that fails when the system is unwell is
 * useless, and the state is in the body. The body is built by `buildUserStatus`
 * and contains no dependency names, error text, latencies or runbook links.
 *
 * Probes are not free, and this route is open to the world, so one computed
 * status serves every caller for `ttlMs` and concurrent callers share a single
 * in-flight check. If the checks themselves throw, the last good status is
 * served (flagged `stale`) or, failing that, an `unknown` status.
 */
export function createStatusRouter(options: StatusRouterOptions = {}): Router {
  const ttlMs = options.ttlMs ?? DEFAULT_STATUS_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error('ttlMs must be a non-negative safe integer');
  const now = options.now ?? (() => new Date());
  const run =
    options.runChecks ??
    ((probes) => runDependencyChecks(probes ?? {}, { timeoutMs: options.probeTimeoutMs, now }));

  let cached: { status: UserStatus; at: number } | null = null;
  let inflight: Promise<{ status: UserStatus; stale: boolean }> | null = null;

  const compute = async (): Promise<{ status: UserStatus; stale: boolean }> => {
    try {
      const status = buildUserStatus(await run(options.probes));
      cached = { status, at: now().getTime() };
      return { status, stale: false };
    } catch {
      return cached ? { status: cached.status, stale: true } : { status: unknownUserStatus(now()), stale: false };
    }
  };

  const router = Router();
  router.get('/status', async (req, res) => {
    let result: { status: UserStatus; stale: boolean };
    if (cached && now().getTime() - cached.at < ttlMs) {
      result = { status: cached.status, stale: false };
    } else {
      inflight ??= compute().finally(() => {
        inflight = null;
      });
      result = await inflight;
    }

    const { status, stale } = result;
    if (status.overall === 'unavailable') {
      const waits = status.features.map((f) => f.retryAfterSeconds ?? 0);
      const retryAfter = Math.max(0, ...waits);
      if (retryAfter > 0) res.setHeader('Retry-After', String(retryAfter));
    }
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
    res.status(200).json({ success: true, data: { ...status, stale }, correlationId: req.correlationId });
  });

  return router;
}

export default createStatusRouter;
