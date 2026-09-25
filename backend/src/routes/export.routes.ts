import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { stellarPublicKeySchema } from '../utils/validation';
import { sendFailure, sendSuccess } from '../types/api';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { ExportForbiddenError, ExportService } from '../exports/export-service';

export interface ExportRouterOptions {
  storage: InvoiceStorage;
  service?: ExportService;
}

const requestSchema = z.object({
  requester: stellarPublicKeySchema,
  /** Optional explicit scope. Must equal `requester`; anything else is denied. */
  sellerPublicKey: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  status: z.enum(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * Data export routes. Mount under `/api`.
 *
 *   POST /exports                 { requester, format?, status?, from?, to? }
 *   GET  /exports/:id?requester=  download while the artifact is retained
 */
export function createExportRouter(options: ExportRouterOptions): Router {
  const service = options.service ?? new ExportService(options.storage);
  const router = Router();

  router.post('/exports', async (req: Request, res: Response) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendFailure(res, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), {
        code: 'INVALID_EXPORT_REQUEST',
        correlationId: req.correlationId,
      });
    }
    const { requester, sellerPublicKey, format, status, from, to } = parsed.data;

    try {
      const artifact = await service.create(
        requester,
        { format, status, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined },
        sellerPublicKey ?? requester
      );

      if (options.storage.recordAuditEvent) {
        await options.storage
          .recordAuditEvent({
            action: 'PROOF_EXPORTED',
            actor: { type: 'seller', id: requester, ip: req.ip },
            scope: { entityType: 'system', entityId: artifact.meta.exportId },
            reason: 'Invoice data export generated',
            metadata: { schemaVersion: artifact.meta.schemaVersion, recordCount: artifact.meta.recordCount, format },
            correlationId: req.correlationId,
          })
          .catch((err) => console.error('Audit log error on export:', err?.message ?? err));
      }

      sendSuccess(res, 201, {
        ...artifact.meta,
        format,
        downloadPath: `/api/exports/${artifact.meta.exportId}?requester=${requester}`,
      });
    } catch (error) {
      if (error instanceof ExportForbiddenError) {
        return sendFailure(res, 403, error.message, { code: 'EXPORT_FORBIDDEN', correlationId: req.correlationId });
      }
      console.error('Export error:', (error as Error)?.stack ?? error);
      sendFailure(res, 500, 'Failed to generate export', { code: 'EXPORT_FAILED', correlationId: req.correlationId });
    }
  });

  router.get('/exports/:id', (req: Request, res: Response) => {
    const requester = stellarPublicKeySchema.safeParse(req.query.requester);
    if (!requester.success) {
      return sendFailure(res, 400, 'requester must be a valid Stellar public key', {
        code: 'REQUESTER_REQUIRED',
        correlationId: req.correlationId,
      });
    }

    const found = service.get(requester.data, req.params.id);
    if (found.state === 'expired') {
      return sendFailure(res, 410, 'This export has expired and was deleted. Generate a new one.', {
        code: 'EXPORT_EXPIRED',
        correlationId: req.correlationId,
      });
    }
    if (found.state === 'not_found') {
      return sendFailure(res, 404, 'Export not found', { code: 'EXPORT_NOT_FOUND', correlationId: req.correlationId });
    }

    const { artifact } = found;
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="quittance-invoices-v${artifact.meta.schemaVersion}.${artifact.format}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(artifact.body);
  });

  return router;
}

export default createExportRouter;
