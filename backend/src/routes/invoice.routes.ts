import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { createInvoiceHandlers, isSimulationEnabled, InvoiceHandlerOptions } from './invoice.handlers';
import { authenticate, requirePermission } from '../middleware/access-control';
import { sendFailure } from '../types/api';
import {
  createInvoiceRateLimiters,
  createVerifyRateLimiters,
  createGetInvoicesRateLimiter,
  createCancelInvoiceRateLimiter,
  verifyConcurrencyLock,
} from '../middleware/rate-limit';
import { createInvoiceCeilingMiddleware } from '../middleware/invoice-ceiling';

export interface InvoiceRouterOptions extends InvoiceHandlerOptions {
  enableRateLimiting?: boolean;
  enableConcurrencyLock?: boolean;
  enableCeilingCheck?: boolean;
  invoiceCeiling?: number;
}

/**
 * Invoice routes shared by both servers. Mount under `/api`.
 *
 * Route list is kept identical between server.ts (Postgres) and
 * server-mvp.ts (in-memory):
 *   POST   /invoices
 *   GET    /invoices/lifecycle
 *   GET    /invoices/stats
 *   GET    /invoices
 *   GET    /invoices/:id
 *   GET    /invoices/:id/payment-info
 *   POST   /invoices/:id/cancel (seller authorized)
 *   POST   /invoices/:id/verify
 *   POST   /invoices/:id/simulate-payment
 *   GET    /invoices/:id/audit
 *
 * Every route declares the permission it needs (see shared/access-control.ts),
 * checked before any handler runs. Handlers then apply the resource-level rule
 * for owner-scoped permissions ("only your own invoices"). A route added here
 * without a `requirePermission` guard fails tests/access-control.test.ts.
 */
export function createInvoiceRouter(options: InvoiceRouterOptions): Router {
  const handlers = createInvoiceHandlers(options);
  const router = Router();

  // Resolve the caller on every invoice route. This never rejects; the
  // per-route guards below decide.
  router.use('/invoices', authenticate());

  const enableRateLimiting =
    options.enableRateLimiting ??
    (process.env.ENABLE_RATE_LIMITING === 'true' || process.env.NODE_ENV === 'production');

  const enableConcurrencyLock =
    options.enableConcurrencyLock ??
    (process.env.ENABLE_VERIFY_CONCURRENCY_LOCK === 'true' || process.env.NODE_ENV === 'production');

  const enableCeilingCheck =
    options.enableCeilingCheck ??
    (process.env.ENABLE_INVOICE_CEILING === 'true' ||
      process.env.NODE_ENV === 'production' ||
      options.invoiceCeiling !== undefined);

  const createMiddlewares: RequestHandler[] = [];
  if (enableCeilingCheck && options.storage.countInvoices) {
    createMiddlewares.push(
      createInvoiceCeilingMiddleware(() => options.storage.countInvoices!(), {
        ceiling: options.invoiceCeiling,
      })
    );
  }
  if (enableRateLimiting) {
    createMiddlewares.push(...createInvoiceRateLimiters());
  }

  router.post(
    '/invoices',
    requirePermission('invoice:create'),
    ...createMiddlewares,
    handlers.createInvoice
  );
  // Static routes stay before the dynamic /invoices/:id so they are not shadowed.
  router.get('/invoices/lifecycle', requirePermission('lifecycle:read'), handlers.getLifecycle);
  router.get('/invoices/stats', requirePermission('invoice:stats'), handlers.getStats);

  const getInvoicesMiddlewares: RequestHandler[] = [];
  if (enableRateLimiting) {
    getInvoicesMiddlewares.push(createGetInvoicesRateLimiter());
  }
  router.get(
    '/invoices',
    requirePermission('invoice:list'),
    ...getInvoicesMiddlewares,
    handlers.getInvoices
  );

  router.get('/invoices/:id', requirePermission('invoice:read'), handlers.getInvoice);

  // GET /invoices/:id/payment-info - Payment info (no rate limit, needed for checkout)
  router.get(
    '/invoices/:id/payment-info',
    requirePermission('invoice:read'),
    handlers.getPaymentInfo
  );
  router.get('/invoices/:id/audit', requirePermission('invoice:audit'), handlers.getAuditTrail);

  const cancelMiddlewares: RequestHandler[] = [];
  const cancelAuthPreCheck: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const requireSig =
      options.requireCancelSignature ?? (process.env.REQUIRE_CANCEL_SIGNATURE === 'true');
    if (requireSig) {
      const sellerKey =
        req.body?.sellerPublicKey || req.headers['x-seller-public-key'] || req.query?.sellerPublicKey;
      const signature =
        req.body?.signature || req.headers['x-signature'] || req.headers['x-seller-signature'];
      if (!sellerKey || !signature) {
        return res.status(401).json({
          success: false,
          code: 'UNAUTHORIZED',
          error: 'Cancellation requires seller proof of ownership (signature)',
        });
      }
    }
    next();
  };
  cancelMiddlewares.push(cancelAuthPreCheck);
  if (enableRateLimiting) {
    cancelMiddlewares.push(createCancelInvoiceRateLimiter());
  }
  router.post(
    '/invoices/:id/cancel',
    requirePermission('invoice:cancel'),
    ...cancelMiddlewares,
    handlers.cancelInvoice
  );

  const verifyMiddlewares: RequestHandler[] = [];
  if (enableConcurrencyLock) {
    verifyMiddlewares.push(verifyConcurrencyLock());
  }
  if (enableRateLimiting) {
    verifyMiddlewares.push(...createVerifyRateLimiters());
  }
  router.post(
    '/invoices/:id/verify',
    requirePermission('invoice:verify'),
    ...verifyMiddlewares,
    handlers.verifyPayment
  );

  // A switched-off simulate endpoint must look like it does not exist, so the
  // switch is checked before authentication can leak that the route is real.
  const simulationSwitch: RequestHandler = (_req, res, next) =>
    isSimulationEnabled(options)
      ? next()
      : sendFailure(res, 404, 'Endpoint not found');
  router.post(
    '/invoices/:id/simulate-payment',
    simulationSwitch,
    requirePermission('invoice:simulate'),
    handlers.simulatePayment
  );

  return router;
}

export default createInvoiceRouter;
