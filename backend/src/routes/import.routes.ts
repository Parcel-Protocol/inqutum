import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { sendFailure, sendSuccess } from '../types/api';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { ImportFormatError, ImportService } from '../imports/import-service';

export interface ImportRouterOptions {
  storage: InvoiceStorage;
  service?: ImportService;
  maxRows?: number;
}

const requestSchema = z.object({
  /**
   * `json` (default) takes `payload` as an array of rows or a JSON string.
   * `csv` takes `payload` as the raw CSV text.
   */
  format: z.enum(['json', 'csv']).default('json'),
  payload: z.unknown(),
  /**
   * Defaults to true. Writing requires an explicit `dryRun: false`, so a
   * caller who posts an import file cannot commit it by accident.
   */
  dryRun: z.boolean().default(true),
  maxRows: z.number().int().positive().optional(),
});

/**
 * Bulk invoice import (issue #53). Mount under `/api`.
 *
 *   POST /imports/invoices   { payload, format?, dryRun?, maxRows? }
 *
 * `dryRun` is the default. Run it first, read `counts` and `remediation`, then
 * re-post the identical payload with `dryRun: false` to commit. Re-posting is
 * safe: rows carrying an `externalId` are matched against existing invoices.
 */
export function createImportRouter(options: ImportRouterOptions): Router {
  const service = options.service ?? new ImportService(options.storage, { maxRows: options.maxRows });
  const router = Router();

  router.post('/imports/invoices', async (req: Request, res: Response) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendFailure(
        res,
        400,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        { code: 'INVALID_IMPORT_REQUEST', correlationId: req.correlationId }
      );
    }

    const { format, payload, dryRun, maxRows } = parsed.data;

    try {
      const plan = dryRun
        ? await service.run({ format, payload, dryRun: true, maxRows })
        : await service.run({ format, payload, dryRun: false, maxRows });

      // A run that could not be parsed or validated wholesale is a client
      // error; per-row failures are reported inside a 200 plan instead.
      return sendSuccess(res, 200, plan, {
        message: dryRun
          ? `Dry run: ${plan.counts.create} to create, ${plan.counts.update} to update, ${plan.counts.skip} unchanged, ${plan.counts.error} rejected. Nothing was written.`
          : `Imported: ${plan.counts.create} created, ${plan.counts.update} updated, ${plan.counts.skip} unchanged, ${plan.counts.error} rejected.`,
        correlationId: req.correlationId,
      });
    } catch (error) {
      if (error instanceof ImportFormatError) {
        return sendFailure(res, 400, error.message, {
          code: 'INVALID_IMPORT_PAYLOAD',
          recoveryAction: 'Fix the file and re-post it. Imports are idempotent when rows carry an externalId.',
          correlationId: req.correlationId,
        });
      }
      throw error;
    }
  });

  return router;
}

export default createImportRouter;
