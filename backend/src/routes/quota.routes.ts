import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/access-control';
import { sendFailure, sendSuccess } from '../types/api';
import { QUOTA_OPERATIONS, quotaManager, type QuotaManager } from '../domain/quota-management';

const operation = z.enum(QUOTA_OPERATIONS);
const overrideSchema = z.object({
  operation,
  actor: z.string().trim().min(1).max(256),
  resource: z.string().trim().min(1).max(256).optional(),
  extraUnits: z.number().int().min(0).max(1_000_000),
  reason: z.string().trim().min(3).max(500),
});
const resetSchema = z.object({
  actor: z.string().trim().min(1).max(256),
  resource: z.string().trim().min(1).max(256).optional(),
  operation: operation.optional(),
});

/** Maintainer-only diagnostics and explicit override/reset controls. */
export function createQuotaRouter(manager: QuotaManager = quotaManager): Router {
  const router = Router();
  router.use('/quotas', authenticate());
  router.get('/quotas', requirePermission('quota:read'), (req: Request, res: Response) => {
    const actor = typeof req.query.actor === 'string' ? req.query.actor.trim() : undefined;
    const resource = typeof req.query.resource === 'string' ? req.query.resource.trim() : undefined;
    return sendSuccess(res, 200, { usage: manager.inspect({ actor, resource }) });
  });
  router.post('/quotas/overrides', requirePermission('quota:override'), (req: Request, res: Response) => {
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) return sendFailure(res, 400, 'Invalid quota override request', 'INVALID_QUOTA_REQUEST');
    try {
      const override = manager.setOverride({ ...parsed.data, setBy: req.actor?.subject ?? 'maintainer' });
      return sendSuccess(res, 200, { override: override ?? null }, { message: override ? 'Quota override applied' : 'Quota override removed' });
    } catch (error: any) {
      return sendFailure(res, 400, error.message, 'INVALID_QUOTA_REQUEST');
    }
  });
  router.post('/quotas/reset', requirePermission('quota:override'), (req: Request, res: Response) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return sendFailure(res, 400, 'Invalid quota reset request', 'INVALID_QUOTA_REQUEST');
    const reset = manager.reset(parsed.data, parsed.data.operation);
    return sendSuccess(res, 200, { reset }, { message: `Reset ${reset} quota bucket(s)` });
  });
  return router;
}

export default createQuotaRouter;
