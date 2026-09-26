import { Router, Request, Response } from 'express';
import { authenticate, requirePermission, mayAccessSeller } from '../middleware/access-control';
import { sendSuccess, sendFailure } from '../types/api';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { EmailQueueService, emailQueueService } from '../services/email-queue.service';
import { EmailAntiSpamService, emailAntiSpamService } from '../services/email-anti-spam.service';

export interface EmailRouterOptions {
  storage: InvoiceStorage;
  queueService?: EmailQueueService;
  antiSpamService?: EmailAntiSpamService;
}

export function createEmailRouter(options: EmailRouterOptions): Router {
  const router = Router();
  const storage = options.storage;
  const queue = options.queueService || emailQueueService;
  const antiSpam = options.antiSpamService || emailAntiSpamService;

  /**
   * POST /invoices/:id/send-email
   * Send invoice link to customer / client email.
   */
  router.post(
    '/invoices/:id/send-email',
    authenticate(),
    requirePermission('invoice:email'),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { recipientEmail, subject, text, html } = req.body || {};

        const invoice = await storage.getInvoiceById(id);
        if (!invoice) {
          return sendFailure(res, 404, 'Invoice not found');
        }

        const targetEmail = recipientEmail || invoice.customerEmail;
        if (!targetEmail) {
          return sendFailure(res, 400, 'Recipient email is required', 'MISSING_RECIPIENT_EMAIL');
        }

        const result = await queue.enqueue({
          invoiceId: invoice.id,
          recipientEmail: targetEmail,
          senderWallet: invoice.sellerPublicKey,
          emailType: 'INVOICE_SENT',
          subject: subject || `Invoice from ${invoice.sellerName || 'Seller'}: ${invoice.memo}`,
          payload: {
            text: text || `You have an invoice for ${invoice.amount} ${invoice.assetCode}. Memo: ${invoice.memo}`,
            html,
            invoice,
          },
        });

        if (!result.success) {
          if (result.code === 'EMAIL_RATE_LIMIT_EXCEEDED') {
            res.set('Retry-After', String(result.retryAfterSeconds || 3600));
            return res.status(429).json({
              success: false,
              code: result.code,
              error: result.error,
              retryAfter: result.retryAfterSeconds,
            });
          }
          return sendFailure(res, 400, result.error || 'Failed to queue email', result.code as any);
        }

        return sendSuccess(res, 202, result.delivery, {
          message: 'Invoice email queued for delivery',
        });
      } catch (error: any) {
        console.error('Send invoice email error:', error);
        return sendFailure(res, 500, error.message || 'Failed to send invoice email');
      }
    }
  );

  /**
   * POST /invoices/:id/send-proof
   * Send payment proof email for paid invoices.
   */
  router.post(
    '/invoices/:id/send-proof',
    authenticate(),
    requirePermission('invoice:email'),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { recipientEmail, subject, text, html } = req.body || {};

        const invoice = await storage.getInvoiceById(id);
        if (!invoice) {
          return sendFailure(res, 404, 'Invoice not found');
        }

        if (invoice.status !== 'PAID') {
          return sendFailure(res, 400, 'Payment proof is only available for paid invoices', 'INVOICE_NOT_PAID');
        }

        const targetEmail = recipientEmail || invoice.payerEmail || invoice.customerEmail || invoice.sellerEmail;
        if (!targetEmail) {
          return sendFailure(res, 400, 'Recipient email is required', 'MISSING_RECIPIENT_EMAIL');
        }

        const result = await queue.enqueue({
          invoiceId: invoice.id,
          recipientEmail: targetEmail,
          senderWallet: invoice.sellerPublicKey,
          emailType: 'PAYMENT_PROOF',
          subject: subject || `Payment Receipt: ${invoice.memo}`,
          payload: {
            text: text || `Your payment for invoice ${invoice.memo} (${invoice.amount} ${invoice.assetCode}) was confirmed on Stellar. Tx: ${invoice.paymentTxHash}`,
            html,
            invoice,
          },
        });

        if (!result.success) {
          if (result.code === 'EMAIL_RATE_LIMIT_EXCEEDED') {
            res.set('Retry-After', String(result.retryAfterSeconds || 3600));
            return res.status(429).json({
              success: false,
              code: result.code,
              error: result.error,
              retryAfter: result.retryAfterSeconds,
            });
          }
          return sendFailure(res, 400, result.error || 'Failed to queue proof email', result.code as any);
        }

        return sendSuccess(res, 202, result.delivery, {
          message: 'Payment proof email queued for delivery',
        });
      } catch (error: any) {
        console.error('Send payment proof email error:', error);
        return sendFailure(res, 500, error.message || 'Failed to send payment proof email');
      }
    }
  );

  /**
   * GET /invoices/:id/deliveries
   * Surface email delivery status, attempts, error, and retry visibility to the freelancer.
   */
  router.get(
    '/invoices/:id/deliveries',
    authenticate(),
    requirePermission('invoice:deliveries'),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const invoice = await storage.getInvoiceById(id);
        if (!invoice) {
          return sendFailure(res, 404, 'Invoice not found');
        }

        if (!mayAccessSeller(req.actor, 'invoice:deliveries', invoice.sellerPublicKey)) {
          return sendFailure(res, 403, 'Forbidden: You do not own this invoice', 'FORBIDDEN');
        }

        const deliveries = await queue.getInvoiceDeliveries(id);
        return sendSuccess(res, 200, deliveries);
      } catch (error: any) {
        console.error('Get invoice deliveries error:', error);
        return sendFailure(res, 500, error.message || 'Failed to get email deliveries');
      }
    }
  );

  /**
   * GET /email/circuit-breaker
   * View email deliverability metrics and circuit breaker status.
   */
  router.get(
    '/email/circuit-breaker',
    authenticate(),
    requirePermission('email:admin'),
    (req: Request, res: Response) => {
      const metrics = antiSpam.getCircuitBreakerMetrics();
      return sendSuccess(res, 200, metrics);
    }
  );

  /**
   * POST /email/circuit-breaker/reset
   * Reset circuit breaker and resume paused queued emails.
   */
  router.post(
    '/email/circuit-breaker/reset',
    authenticate(),
    requirePermission('email:admin'),
    async (req: Request, res: Response) => {
      antiSpam.resetCircuitBreaker();
      const resumedCount = await queue.resumePausedEmails();
      return sendSuccess(res, 200, {
        isTripped: false,
        resumedCount,
      }, {
        message: `Circuit breaker reset. Resumed ${resumedCount} paused emails.`,
      });
    }
  );

  return router;
}

export default createEmailRouter;
