import { Router } from 'express';
import stellarController from '../controllers/stellar.controller';
import paymentMonitorService from '../services/payment-monitor.service';
import postgresInvoiceStorage from '../storage/postgres-invoice-storage';
import { createInvoiceRouter } from './invoice.routes';
import { createPaymentMonitorRouter } from './payment-monitor.routes';
import { healthHandler, readinessHandler } from '../health';
import { PostgresIdempotencyStore } from '../idempotency/postgres-store';
import { createAuthRouter } from './auth.routes';
import { createReconciliationRouter } from './reconciliation.routes';
import { authenticate, requirePermission } from '../middleware/access-control';

const router = Router();

// Health check
router.get('/health', healthHandler(postgresInvoiceStorage.mode));
router.get('/ready', readinessHandler(postgresInvoiceStorage.mode));

// Invoice routes — same handlers the MVP server uses, backed by PostgreSQL
router.use(
  createInvoiceRouter({
    storage: postgresInvoiceStorage,
    idempotencyStore: new PostgresIdempotencyStore(),
  })
);

// Wallet sign-in and role introspection
router.use(createAuthRouter());

// Read-only reconciliation dry run (operators and services only)
router.use(createReconciliationRouter({ storage: postgresInvoiceStorage }));

// Stellar routes. These proxy Horizon on the server's quota, so they need a
// signed-in caller rather than being an open relay.
router.use('/stellar', authenticate(), requirePermission('stellar:read'));
router.get('/stellar/account', stellarController.getAccountInfo.bind(stellarController));
router.get('/stellar/payments', stellarController.getPayments.bind(stellarController));
router.get('/stellar/transaction/:hash', stellarController.getTransaction.bind(stellarController));
router.post('/stellar/verify-payment', stellarController.verifyPayment.bind(stellarController));
router.use(createPaymentMonitorRouter(paymentMonitorService));

export default router;
