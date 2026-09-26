import { Router } from 'express';
import stellarController from '../controllers/stellar.controller';
import paymentMonitorService from '../services/payment-monitor.service';
import postgresInvoiceStorage from '../storage/postgres-invoice-storage';
import { createInvoiceRouter } from './invoice.routes';
import { createAuditRouter } from './audit.routes';
import { createExportRouter } from './export.routes';
import { createImportRouter } from './import.routes';
import { createNotificationRouter } from './notification.routes';
import { createObservabilityRouter } from './observability.routes';
import { createJobsRouter } from './jobs.routes';
import { createOpsRouter } from './ops.routes';
import { PostgresJobStore } from '../jobs/postgres-job-store';
import { pool } from '../config/database';
import { healthHandler, readinessHandler } from '../health';

const router = Router();

// Health check
router.get('/health', healthHandler(postgresInvoiceStorage.mode));
router.get('/ready', readinessHandler(postgresInvoiceStorage.mode));

// Invoice routes — same handlers the MVP server uses, backed by PostgreSQL
router.use(createInvoiceRouter({ storage: postgresInvoiceStorage }));
router.use(createAuditRouter({ storage: postgresInvoiceStorage }));
router.use(createObservabilityRouter({ storage: postgresInvoiceStorage }));
router.use(createNotificationRouter());
router.use(createExportRouter({ storage: postgresInvoiceStorage }));
// Bulk import (issue #53). Dry run by default; opt in with dryRun: false.
router.use(createImportRouter({ storage: postgresInvoiceStorage }));

const jobStore = new PostgresJobStore(pool);
router.use(createJobsRouter({ store: jobStore }));
router.use(createOpsRouter({ storage: postgresInvoiceStorage, jobs: jobStore }));

// Stellar routes
router.get('/stellar/account', stellarController.getAccountInfo.bind(stellarController));
router.get('/stellar/payments', stellarController.getPayments.bind(stellarController));
router.get('/stellar/transaction/:hash', stellarController.getTransaction.bind(stellarController));
router.post('/stellar/verify-payment', stellarController.verifyPayment.bind(stellarController));

// Payment monitoring routes
router.post('/payment/sync', async (req, res) => {
  try {
    const limit = req.body.limit || 50;
    await paymentMonitorService.manualSync(limit);
    res.json({
      success: true,
      message: `Payment sync completed`,
      limit
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Sync failed'
    });
  }
});

export default router;
