import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { stellarPublicKeySchema } from '../utils/validation';
import { sendFailure, sendSuccess } from '../types/api';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { ExportCancelledError, ExportForbiddenError, ExportService } from '../exports/export-service';
import { EXPORT_FIELDS } from '../exports/export-fields';
import { resolveExportAccess } from '../exports/export-field-policy';
import { authenticate } from '../middleware/access-control';
import { ANONYMOUS_ACTOR } from '../auth/actor';

export interface ExportRouterOptions {
  storage: InvoiceStorage;
  service?: ExportService;
  /** Server-side deadline for generating one export (#288). Defaults to 30 s. */
  timeoutMs?: number;
}

export const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;

const requestSchema = z.object({
  requester: stellarPublicKeySchema,
  /** Optional explicit scope. Must equal `requester`; anything else is denied. */
  sellerPublicKey: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  status: z.enum(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** Columns to blank out (#354). Narrows the caller's own view; never widens it. */
  redactFields: z.array(z.enum(EXPORT_FIELDS)).max(EXPORT_FIELDS.length).optional(),
});

/**
 * Data export routes. Mount under `/api`.
 *
 *   POST /exports                 { requester, format?, status?, from?, to?, redactFields? }
 *   GET  /exports/:id?requester=  download while the artifact is retained
 *
 * Who sees what (#354, docs/EXPORTS.md): a wallet session (`end_user`) exports
 * only its own wallet, in full. A `maintainer` or `service` token may export any
 * seller's wallet but receives the redacted `operator` view, and owns the file.
 * With no credentials the caller asserts a wallet, as before. A credential that
 * is present but invalid is a 401, never a silent downgrade to that path.
 */
export function createExportRouter(options: ExportRouterOptions): Router {
  const service = options.service ?? new ExportService(options.storage);
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive safe integer');
  const router = Router();
  router.use('/exports', authenticate());

  router.post('/exports', async (req: Request, res: Response) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendFailure(res, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), {
        code: 'INVALID_EXPORT_REQUEST',
        correlationId: req.correlationId,
      });
    }
    const { requester, sellerPublicKey, format, status, from, to, redactFields } = parsed.data;

    const access = resolveExportAccess({
      actor: req.actor ?? ANONYMOUS_ACTOR,
      authFailed: Boolean(req.authFailure),
      requester,
      scope: sellerPublicKey,
    });
    if (!access.ok) {
      const httpStatus = access.code === 'EXPORT_UNAUTHENTICATED' ? 401 : 403;
      if (httpStatus === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      return sendFailure(res, httpStatus, access.message, { code: access.code, correlationId: req.correlationId });
    }

    // Cancellation (#288): a client that disconnects, or a run past the
    // deadline, stops generation at the next storage page. `res` (not `req`)
    // emits 'close' when the socket goes away before the response is written.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    try {
      const artifact = await service.create(
        access.owner,
        { format, status, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, redactFields },
        access.scope,
        controller.signal,
        { viewer: access.viewer }
      );

      if (options.storage.recordAuditEvent) {
        await options.storage
          .recordAuditEvent({
            action: 'PROOF_EXPORTED',
            actor: { type: access.viewer === 'operator' ? 'maintainer' : 'seller', id: access.owner, ip: req.ip },
            scope: { entityType: 'system', entityId: artifact.meta.exportId },
            reason: 'Invoice data export generated',
            metadata: {
              schemaVersion: artifact.meta.schemaVersion,
              recordCount: artifact.meta.recordCount,
              format,
              viewer: access.viewer,
              exportedWallet: access.scope,
              redactedFields: artifact.meta.redactedFields,
            },
            correlationId: req.correlationId,
          })
          .catch((err) => console.error('Audit log error on export:', err?.message ?? err));
      }

      sendSuccess(res, 201, {
        ...artifact.meta,
        format,
        // Operators are identified by their token, so they need no `requester` query.
        downloadPath:
          access.viewer === 'operator'
            ? `/api/exports/${artifact.meta.exportId}`
            : `/api/exports/${artifact.meta.exportId}?requester=${access.owner}`,
      });
    } catch (error) {
      if (error instanceof ExportForbiddenError) {
        return sendFailure(res, 403, error.message, { code: 'EXPORT_FORBIDDEN', correlationId: req.correlationId });
      }
      if (error instanceof ExportCancelledError) {
        // Nothing was stored. A disconnected client has nobody to answer.
        if (res.destroyed) return;
        return sendFailure(res, 503, 'Export took too long and was cancelled. Narrow the filters and try again.', {
          code: 'EXPORT_TIMED_OUT',
          retryable: true,
          correlationId: req.correlationId,
        });
      }
      console.error('Export error:', (error as Error)?.stack ?? error);
      sendFailure(res, 500, 'Failed to generate export', { code: 'EXPORT_FAILED', correlationId: req.correlationId });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }
  });

  router.get('/exports/:id', (req: Request, res: Response) => {
    if (req.authFailure) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendFailure(res, 401, 'The credentials provided are invalid or have expired', {
        code: 'EXPORT_UNAUTHENTICATED',
        correlationId: req.correlationId,
      });
    }

    // An operator's artifacts are owned by the operator, never by the seller
    // whose data they hold; everyone else is identified by the wallet they name
    // (bound to their session when they have one).
    const actor = req.actor ?? ANONYMOUS_ACTOR;
    let owner: string;
    if (actor.role === 'maintainer' || actor.role === 'service') {
      owner = actor.subject;
    } else {
      const requester = stellarPublicKeySchema.safeParse(req.query.requester);
      if (!requester.success) {
        return sendFailure(res, 400, 'requester must be a valid Stellar public key', {
          code: 'REQUESTER_REQUIRED',
          correlationId: req.correlationId,
        });
      }
      // Same answer as an unknown id: do not reveal that another wallet's artifact exists.
      if (actor.role === 'end_user' && actor.wallet !== requester.data) {
        return sendFailure(res, 404, 'Export not found', { code: 'EXPORT_NOT_FOUND', correlationId: req.correlationId });
      }
      owner = requester.data;
    }

    const found = service.get(owner, req.params.id);
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
