import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/access-control';
import { sendFailure, sendSuccess } from '../types/api';
import { analyticsStore, hourlyTimeWindow, type AnalyticsOperation } from '../domain/analytics';

const operationEnum = z.enum([
  'invoice_create',
  'horizon_verify',
  'email_enqueue',
  'import_row',
  'search_index',
  'payment_verify',
  'dashboard_list',
  'auth_challenge',
]);

const querySchema = z.object({
  operation: operationEnum.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * Maintainer-only analytics endpoints.
 *
 * These endpoints expose privacy-safe aggregates only. No raw events,
 * actor identities, or sensitive payloads are ever returned.
 */
export function createAnalyticsRouter(store = analyticsStore): Router {
  const router = Router();

  router.use('/analytics', authenticate());

  /**
   * GET /analytics/summary
   *
   * Returns aggregated analytics for the requested time range.
   * Query params:
   * - operation: filter by a specific operation type
   * - from: ISO datetime for the start of the range
   * - to: ISO datetime for the end of the range
   */
  router.get('/analytics/summary', requirePermission('analytics:read'), (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendFailure(res, 400, 'Invalid analytics query parameters');
    }

    const { operation, from, to } = parsed.data;
    const summary = store.query({
      operation,
      fromMs: from ? new Date(from).getTime() : undefined,
      toMs: to ? new Date(to).getTime() : undefined,
    });

    return sendSuccess(res, 200, summary);
  });

  /**
   * GET /analytics/operations
   *
   * Returns the list of tracked operations and their current bucket counts.
   * Useful for discovering what metrics are available.
   */
  router.get('/analytics/operations', requirePermission('analytics:read'), (_req: Request, res: Response) => {
    const operations: AnalyticsOperation[] = [
      'invoice_create',
      'horizon_verify',
      'email_enqueue',
      'import_row',
      'search_index',
      'payment_verify',
      'dashboard_list',
      'auth_challenge',
    ];

    return sendSuccess(res, 200, {
      operations,
      retentionHours: 24 * 7,
      bucketCount: store.bucketCount,
    });
  });

  /**
   * POST /analytics/clear
   *
   * Clears all analytics data. This is a destructive operation and should
   * only be used for testing or privacy compliance requests.
   */
  router.post('/analytics/clear', requirePermission('analytics:clear'), (_req: Request, res: Response) => {
    store.clear();
    return sendSuccess(res, 200, { cleared: true }, { message: 'Analytics data cleared' });
  });

  return router;
}

export default createAnalyticsRouter;
