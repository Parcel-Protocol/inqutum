import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { analyticsStore, hashActor, hourlyTimeWindow, type AnalyticsEvent, type AnalyticsOperation, type AnalyticsStatus } from '../domain/analytics';

/**
 * Analytics tracking middleware.
 *
 * Records privacy-safe analytics events for each request. No raw sensitive
 * data is stored — only aggregated counts, rates, and percentiles by safe
 * dimensions.
 *
 * Privacy guarantees:
 * - Actor identities are one-way hashed before storage
 * - No raw request/response bodies are stored
 * - No wallet addresses, emails, or transaction hashes are stored
 * - Only safe dimension values (operation, status, time window, error code) are recorded
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      analyticsContext?: {
        operation: AnalyticsOperation;
        startTimeMs: number;
        assetType?: 'native' | 'credit';
      };
    }
  }
}

/**
 * Mark a request for analytics tracking with a specific operation type.
 * This should be called early in the request lifecycle, before the operation
 * is performed.
 */
export function trackOperation(operation: AnalyticsOperation, assetType?: 'native' | 'credit'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.analyticsContext = {
      operation,
      startTimeMs: Date.now(),
      ...(assetType ? { assetType } : {}),
    };
    next();
  };
}

/**
 * Record an analytics event for the current request.
 * Should be called after the operation completes (success or failure).
 */
export function recordAnalyticsEvent(
  req: Request,
  status: AnalyticsStatus,
  errorCode?: string,
  nowMs: number = Date.now()
): void {
  const context = req.analyticsContext;
  if (!context) return;

  const latencyMs = nowMs - context.startTimeMs;
  const actorIdentity = req.actor?.wallet ?? req.actor?.subject ?? req.ip ?? 'anonymous';

  const event: AnalyticsEvent = {
    operation: context.operation,
    status,
    timeWindow: hourlyTimeWindow(nowMs),
    ...(context.assetType ? { assetType: context.assetType } : {}),
    ...(errorCode ? { errorCode } : {}),
    latencyMs,
    actorHash: hashActor(actorIdentity),
  };

  analyticsStore.record(event, nowMs);
}

/**
 * Analytics middleware that automatically tracks the request lifecycle.
 * Must be used after `authenticate()` so the actor is resolved.
 */
export function analyticsMiddleware(operation: AnalyticsOperation, assetType?: 'native' | 'credit'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.analyticsContext = {
      operation,
      startTimeMs: Date.now(),
      ...(assetType ? { assetType } : {}),
    };

    // Record the event when the response finishes
    res.on('finish', () => {
      const nowMs = Date.now();
      const latencyMs = nowMs - (req.analyticsContext?.startTimeMs ?? nowMs);
      const actorIdentity = req.actor?.wallet ?? req.actor?.subject ?? req.ip ?? 'anonymous';

      let status: AnalyticsStatus = 'success';
      if (res.statusCode === 429) {
        status = 'rate_limited';
      } else if (res.statusCode >= 400) {
        status = 'failure';
      }

      const event: AnalyticsEvent = {
        operation,
        status,
        timeWindow: hourlyTimeWindow(nowMs),
        ...(assetType ? { assetType } : {}),
        latencyMs,
        actorHash: hashActor(actorIdentity),
      };

      analyticsStore.record(event, nowMs);
    });

    next();
  };
}
