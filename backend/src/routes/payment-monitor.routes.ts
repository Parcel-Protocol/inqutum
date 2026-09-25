import { Router, Request, Response } from 'express';
import paymentMonitorService, { PaymentMonitorService } from '../services/payment-monitor.service';
import { authenticate, requirePermission } from '../middleware/access-control';

/**
 * Creates the payment monitor HTTP router.
 */
export function createPaymentMonitorRouter(
  monitor: PaymentMonitorService = paymentMonitorService
): Router {
  const router = Router();

  router.use('/payment', authenticate());

  router.post('/payment/sync', requirePermission('monitor:sync'), async (req: Request, res: Response) => {
    try {
      const limit = Number(req.body?.limit) || 50;
      await monitor.manualSync(limit);
      res.json({
        success: true,
        message: 'Payment sync completed',
        limit,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error?.message || 'Sync failed',
      });
    }
  });

  router.get('/payment/monitor/status', requirePermission('monitor:read'), (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: monitor.getStatus(),
    });
  });

  return router;
}

export default createPaymentMonitorRouter;
