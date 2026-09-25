import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requirePermission } from '../middleware/access-control';
import { runReconciliation } from '../services/reconciliation.service';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { sendFailure, sendSuccess } from '../types/api';

/**
 * `GET /reconciliation` runs a dry-run reconciliation and returns the report.
 *
 * It is a GET because it changes nothing: the data access is read-only by
 * construction (see InvoiceStorage.listInvoicesForReconciliation), and the
 * report has no "apply" counterpart. Repair guidance in the report is for an
 * operator to act on deliberately.
 *
 * Query: `graceMinutes` (0 to 1440) sets how long past expiry a PENDING invoice
 * may sit before it counts as stale.
 */
export function createReconciliationRouter(options: { storage: InvoiceStorage }): Router {
  const router = Router();

  router.get(
    '/reconciliation',
    authenticate(),
    requirePermission('reconciliation:run'),
    async (req: Request, res: Response) => {
      try {
        let staleGraceMs: number | undefined;
        if (req.query.graceMinutes !== undefined) {
          const minutes = Number(req.query.graceMinutes);
          if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
            return sendFailure(res, 400, 'graceMinutes must be a number between 0 and 1440');
          }
          staleGraceMs = minutes * 60_000;
        }

        sendSuccess(res, 200, await runReconciliation(options.storage, { staleGraceMs }));
      } catch (error: any) {
        console.error('Reconciliation error:', error?.stack || error?.message || error);
        sendFailure(res, 500, error?.message || 'Failed to run reconciliation');
      }
    }
  );

  return router;
}

export default createReconciliationRouter;
