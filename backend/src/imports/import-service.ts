import { z } from 'zod';
import { importRowSchema, type ImportRow } from '../utils/validation';
import { EXPORT_SCHEMA_ID } from '../exports/export-service';
import type { InvoiceStorage, StoredInvoice } from '../storage/invoice-storage';

/**
 * Bulk invoice import with dry-run validation (issue #53).
 *
 * The pipeline is deliberately two-phase:
 *
 *   parse -> validate -> plan  (read-only; safe to run on production data)
 *   plan  -> apply             (the only phase that writes)
 *
 * `plan()` is what `dryRun: true` returns, and it performs no persistent
 * writes: it never calls `createInvoice` or `updateInvoiceMutableFields`, and
 * it resolves existing rows through `getInvoiceByExternalId`, which is
 * documented on the storage contract as not applying the lazy expiry
 * transition. That is the whole reason the read-only lookup exists as a
 * separate method rather than reusing `getInvoiceById`.
 *
 * Identity and idempotency
 * ------------------------
 * A row's `externalId` is its identity in the caller's system. Re-importing a
 * file is then safe:
 *
 *   - no externalId      -> always `create` (nothing to match on; documented)
 *   - externalId, unseen -> `create`
 *   - externalId, seen, descriptive fields identical -> `skip` (no write)
 *   - externalId, seen, descriptive fields differ    -> `update`
 *   - externalId, seen, an immutable field differs    -> `error`
 *
 * `update` is limited to the five descriptive fields. Amount, asset, seller
 * and lifecycle columns are settled facts or security boundaries, so a bulk
 * re-import can never rewrite them; a row that disagrees about one of those is
 * reported as an error rather than silently ignored.
 */

export const IMPORT_SCHEMA_ID = 'quittance.invoice-import';
export const IMPORT_SCHEMA_VERSION = 1;

/**
 * Accepted input fields, in the order used for CSV header documentation.
 *
 * This is deliberately NOT the export schema (`quittance.invoice-export`).
 * An export is a read-only projection and omits `sellerPublicKey` and
 * `expiresInDays`, so it cannot be imported. `assertNotExportPayload`
 * detects that shape and explains the difference instead of failing with a
 * wall of field errors.
 */
export const IMPORT_FIELDS = [
  'externalId',
  'sellerPublicKey',
  'sellerName',
  'sellerEmail',
  'amount',
  'assetCode',
  'assetIssuer',
  'description',
  'customerName',
  'customerEmail',
  'expiresInDays',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Fields a re-import may rewrite on an existing invoice. */
const MUTABLE_FIELDS = [
  'description',
  'customerName',
  'customerEmail',
  'sellerName',
  'sellerEmail',
] as const;

/** Fields that are compared but never rewritten; a mismatch is an error. */
const IMMUTABLE_FIELDS = ['sellerPublicKey', 'amount', 'assetCode', 'assetIssuer'] as const;

export type ImportAction = 'create' | 'update' | 'skip' | 'error';

export interface ImportRowPlan {
  /** 1-based position in the source file, so errors point at a real line. */
  row: number;
  externalId?: string;
  action: ImportAction;
  /** Human-readable explanation. Safe to return to the caller. */
  reason?: string;
  /** Existing invoice for `skip`/`update`; the new invoice for an applied create. */
  invoiceId?: string;
}

export interface ImportCounts {
  create: number;
  update: number;
  skip: number;
  error: number;
}

export interface ImportRollback {
  /** How to reverse what this run wrote. */
  strategy: 'cancel-created';
  /** Invoices this run created; cancel these to undo the import. */
  invoiceIds: string[];
  note: string;
}

export interface ImportPlan {
  dryRun: boolean;
  format: ImportFormat;
  total: number;
  counts: ImportCounts;
  rows: ImportRowPlan[];
  /** externalIds appearing more than once in this file. */
  duplicateExternalIds: string[];
  /** Populated only on an applied run. */
  rollback?: ImportRollback;
  /** Actionable next steps, ordered. Empty when nothing went wrong. */
  remediation: string[];
}

export type ImportFormat = 'json' | 'csv';

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

export interface ImportRequest {
  format?: ImportFormat;
  /** Parsed rows for `json`, or raw text for `csv`. */
  payload: unknown;
  /** When true, plan only and perform no writes. Defaults to true. */
  dryRun?: boolean;
  /** Guard rail: refuse files larger than this many rows. */
  maxRows?: number;
}

export const DEFAULT_MAX_IMPORT_ROWS = 1000;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const BOOLEANISH = new Set(['true', 'false']);

/**
 * Coerce a CSV cell to the type the row schema expects.
 *
 * Numbers arrive as text from CSV, so `amount` and `expiresInDays` are parsed
 * here rather than being left to zod (which would reject the string `"10"`).
 * A non-numeric amount is passed through as the original string so the row
 * fails validation with a message about `amount`, rather than silently
 * becoming NaN.
 */
function coerceCell(field: string, value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (field === 'amount' || field === 'expiresInDays') {
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }
  if (BOOLEANISH.has(trimmed.toLowerCase())) return trimmed.toLowerCase() === 'true';
  return value;
}

/**
 * Minimal RFC 4180 CSV reader: quoted fields, `""` escapes, CRLF or LF.
 *
 * Hand-rolled because the export side already hand-rolls `csvCell` and the
 * project takes no CSV dependency; this is the exact inverse of that writer.
 */
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    // Ignore the trailing newline that produced an empty final record.
    if (record.length === 1 && record[0] === '') return;
    rows.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field !== '' || record.length > 0) pushRecord();

  if (rows.length === 0) {
    throw new ImportFormatError('CSV payload is empty. Provide a header row and at least one data row.');
  }

  const header = rows[0].map((h) => h.trim());
  const unknown = header.filter((h) => h !== '' && !IMPORT_FIELDS.includes(h as ImportField));
  if (unknown.length > 0) {
    throw new ImportFormatError(
      `Unsupported CSV column(s): ${unknown.join(', ')}. Supported columns are: ${IMPORT_FIELDS.join(', ')}.`,
    );
  }

  return rows.slice(1).map((cells) => {
    const record: Record<string, unknown> = {};
    header.forEach((name, index) => {
      if (name === '') return;
      record[name] = coerceCell(name, cells[index] ?? '');
    });
    return record;
  });
}

/**
 * Reject an export document with an explanation.
 *
 * An export carries `id`, `memo`, `status` and `paymentTxHash` and omits
 * `sellerPublicKey`, so feeding one back in produces a confusing wall of
 * "sellerPublicKey required" errors. Naming the mismatch is the difference
 * between a fixable report and a dead end.
 */
function assertNotExportPayload(value: Record<string, unknown>): void {
  const exportOnly = ['id', 'memo', 'status', 'paymentTxHash', 'createdAt', 'expiresAt'].filter(
    (k) => k in value
  );
  const looksLikeInvoice = !('sellerPublicKey' in value) && exportOnly.length > 0;
  if (!looksLikeInvoice) return;

  throw new ImportFormatError(
    `This looks like a ${EXPORT_SCHEMA_ID} document, not an import file ` +
      `(found ${exportOnly.join(', ')} but no sellerPublicKey). ` +
      'An export is a read-only projection and cannot be re-imported: it omits sellerPublicKey and expiresInDays. ' +
      `Build an import file with these fields instead: ${IMPORT_FIELDS.join(', ')}.`,
  );
}

export function parsePayload(format: ImportFormat, payload: unknown): Record<string, unknown>[] {
  if (format === 'csv') {
    if (typeof payload !== 'string') {
      throw new ImportFormatError('A csv import requires `payload` to be the raw CSV text as a string.');
    }
    return parseCsv(payload);
  }

  let rows: unknown;
  if (typeof payload === 'string') {
    try {
      rows = JSON.parse(payload);
    } catch (error) {
      throw new ImportFormatError(
        `Payload is not valid JSON: ${(error as Error).message}. Send a JSON array of invoice rows, or set format: "csv".`
      );
    }
  } else {
    rows = payload;
  }

  if (!Array.isArray(rows)) {
    if (rows && typeof rows === 'object') {
      const record = rows as Record<string, unknown>;
      // Unwrap the common envelopes before deciding it is unusable.
      for (const key of ['rows', 'invoices', 'data'] as const) {
        if (Array.isArray(record[key])) {
          rows = record[key];
          break;
        }
      }
      if (!Array.isArray(rows)) {
        assertNotExportPayload(record);
        throw new ImportFormatError(
          'JSON payload must be an array of invoice rows, or an object with a `rows`/`invoices`/`data` array.'
        );
      }
    } else {
      throw new ImportFormatError('JSON payload must be an array of invoice rows.');
    }
  }

  if (rows.length === 0) {
    throw new ImportFormatError('Import contains no rows.');
  }

  return (rows as unknown[]).map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ImportFormatError(
        `Row ${index + 1} is not an object. Each row must be a JSON object of invoice fields.`
      );
    }
    const record = row as Record<string, unknown>;
    assertNotExportPayload(record);
    return record;
  });
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Normalise `undefined` and `''` to one comparable value. */
function sameValue(a: unknown, b: unknown): boolean {
  const left = a === undefined || a === '' ? undefined : a;
  const right = b === undefined || b === '' ? undefined : b;
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  return String(left) === String(right);
}

function describeChanges(row: ImportRow, existing: StoredInvoice): string[] {
  const changes: string[] = [];
  for (const field of MUTABLE_FIELDS) {
    if (!sameValue(row[field], existing[field])) changes.push(field);
  }
  return changes;
}

function describeConflicts(row: ImportRow, existing: StoredInvoice): string[] {
  const conflicts: string[] = [];
  for (const field of IMMUTABLE_FIELDS) {
    const supplied = row[field];
    // Only a *supplied* value can conflict; an omitted field is not a change.
    if (supplied === undefined) continue;
    if (!sameValue(supplied, existing[field])) conflicts.push(field);
  }
  return conflicts;
}

export interface ImportServiceOptions {
  maxRows?: number;
}

export class ImportService {
  private readonly maxRows: number;

  constructor(
    private readonly storage: InvoiceStorage,
    options: ImportServiceOptions = {}
  ) {
    this.maxRows = options.maxRows ?? DEFAULT_MAX_IMPORT_ROWS;
  }

  /**
   * The row limit for one call.
   *
   * The constructor option is a deployment ceiling. A per-call value may only
   * tighten it, never raise it, so a caller cannot lift the server's cap by
   * passing a larger `maxRows` in the request body.
   */
  private resolveLimit(perCall?: number): number {
    return perCall === undefined ? this.maxRows : Math.min(this.maxRows, perCall);
  }

  private assertRowLimit(rows: unknown[], limit: number): void {
    if (rows.length > limit) {
      throw new ImportFormatError(
        `Import has ${rows.length} rows, which exceeds the limit of ${limit}. Split the file and import in batches.`
      );
    }
  }

  /**
   * Plan an import without writing anything.
   *
   * Safe on production data: no creates, no updates, and the existence check
   * goes through the read-only `getInvoiceByExternalId`.
   */
  async plan(
    format: ImportFormat,
    rows: Record<string, unknown>[],
    maxRows?: number
  ): Promise<ImportPlan> {
    this.assertRowLimit(rows, this.resolveLimit(maxRows));

    const rowPlans: ImportRowPlan[] = [];
    const counts: ImportCounts = { create: 0, update: 0, skip: 0, error: 0 };

    // externalId -> first row number it appeared on, for in-file duplicates.
    const seenInFile = new Map<string, number>();
    const duplicateExternalIds: string[] = [];

    for (const [index, raw] of rows.entries()) {
      const rowNumber = index + 1;
      const parsed = importRowSchema.safeParse(raw);

      if (!parsed.success) {
        counts.error += 1;
        rowPlans.push({
          row: rowNumber,
          externalId: typeof raw.externalId === 'string' ? raw.externalId : undefined,
          action: 'error',
          reason: formatIssues(parsed.error),
        });
        continue;
      }

      const row = parsed.data;
      const externalId = row.externalId;

      if (externalId) {
        const firstSeen = seenInFile.get(externalId);
        if (firstSeen !== undefined) {
          // Two rows in one file claim the same identity. Applying them in
          // order would make the result depend on row order, so refuse and
          // let the caller decide which one is correct.
          if (!duplicateExternalIds.includes(externalId)) duplicateExternalIds.push(externalId);
          counts.error += 1;
          rowPlans.push({
            row: rowNumber,
            externalId,
            action: 'error',
            reason: `Duplicate externalId "${externalId}" — already used by row ${firstSeen} in this file. Keep one row per externalId.`,
          });
          continue;
        }
        seenInFile.set(externalId, rowNumber);
      }

      // No key means nothing to match on, so the only possible action is create.
      if (!externalId) {
        counts.create += 1;
        rowPlans.push({
          row: rowNumber,
          action: 'create',
          reason: 'No externalId supplied; this row cannot be matched on re-import and will create a new invoice each time.',
        });
        continue;
      }

      const existing = await this.storage.getInvoiceByExternalId(externalId);

      if (!existing) {
        counts.create += 1;
        rowPlans.push({ row: rowNumber, externalId, action: 'create' });
        continue;
      }

      const conflicts = describeConflicts(row, existing);
      if (conflicts.length > 0) {
        counts.error += 1;
        rowPlans.push({
          row: rowNumber,
          externalId,
          action: 'error',
          invoiceId: existing.id,
          reason:
            `externalId "${externalId}" already exists as invoice ${existing.id}, but this row changes ` +
            `${conflicts.join(', ')}. Amount, asset and seller cannot be changed by an import. ` +
            'Remove those fields from the row to re-import the descriptive fields only, or update the invoice directly.',
        });
        continue;
      }

      const changes = describeChanges(row, existing);
      if (changes.length === 0) {
        counts.skip += 1;
        rowPlans.push({
          row: rowNumber,
          externalId,
          action: 'skip',
          invoiceId: existing.id,
          reason: 'Already imported and unchanged.',
        });
        continue;
      }

      counts.update += 1;
      rowPlans.push({
        row: rowNumber,
        externalId,
        action: 'update',
        invoiceId: existing.id,
        reason: `Will update ${changes.join(', ')} on invoice ${existing.id}.`,
      });
    }

    return {
      dryRun: true,
      format,
      total: rows.length,
      counts,
      rows: rowPlans,
      duplicateExternalIds,
      remediation: buildRemediation(counts, duplicateExternalIds, rowPlans),
    };
  }

  /**
   * Apply a planned import.
   *
   * Rows are applied independently: a row that throws is recorded as an error
   * and the run continues, so one bad row cannot discard the rest. The
   * returned plan reports exactly what was written, and `rollback` lists the
   * invoices this run created so the import can be undone.
   */
  async apply(
    format: ImportFormat,
    rows: Record<string, unknown>[],
    maxRows?: number
  ): Promise<ImportPlan> {
    const limit = this.resolveLimit(maxRows);
    this.assertRowLimit(rows, limit);

    const plan = await this.plan(format, rows, limit);
    const rowPlans: ImportRowPlan[] = [];
    const counts: ImportCounts = { create: 0, update: 0, skip: 0, error: 0 };
    const createdInvoiceIds: string[] = [];

    for (const planned of plan.rows) {
      // A row that failed validation, clashed in-file, or conflicted with an
      // immutable field is not attempted.
      if (planned.action === 'error') {
        counts.error += 1;
        rowPlans.push(planned);
        continue;
      }

      const raw = rows[planned.row - 1];
      const parsed = importRowSchema.safeParse(raw);
      if (!parsed.success) {
        counts.error += 1;
        rowPlans.push(planned);
        continue;
      }
      const row = parsed.data;

      try {
        if (planned.action === 'skip') {
          counts.skip += 1;
          rowPlans.push(planned);
          continue;
        }

        if (planned.action === 'create') {
          const created = await this.storage.createInvoice(row);
          counts.create += 1;
          createdInvoiceIds.push(created.id);
          rowPlans.push({ ...planned, invoiceId: created.id, reason: 'Created.' });
          continue;
        }

        // update
        const patch: Record<string, string> = {};
        for (const field of MUTABLE_FIELDS) {
          const value = row[field];
          if (value !== undefined) patch[field] = value as string;
        }
        const updated = await this.storage.updateInvoiceMutableFields(planned.invoiceId!, patch);
        if (!updated) {
          // The invoice disappeared between planning and applying.
          counts.error += 1;
          rowPlans.push({
            ...planned,
            action: 'error',
            reason: `Invoice ${planned.invoiceId} no longer exists; nothing was updated. Re-run the import.`,
          });
          continue;
        }
        counts.update += 1;
        rowPlans.push({ ...planned, reason: `Updated ${Object.keys(patch).join(', ')}.` });
      } catch (error) {
        // Partial failure: record and keep going.
        counts.error += 1;
        rowPlans.push({
          ...planned,
          action: 'error',
          reason: `Failed: ${(error as Error).message}`,
        });
      }
    }

    return {
      dryRun: false,
      format,
      total: rows.length,
      counts,
      rows: rowPlans,
      duplicateExternalIds: plan.duplicateExternalIds,
      rollback: {
        strategy: 'cancel-created',
        invoiceIds: createdInvoiceIds,
        note:
          createdInvoiceIds.length === 0
            ? 'This run created no invoices, so there is nothing to roll back.'
            : `To undo this import, cancel each of these ${createdInvoiceIds.length} invoice(s) while they are still PENDING: ` +
              `${createdInvoiceIds.join(', ')}. Imports never update or delete existing invoices, so only created rows need reversing.`,
      },
      remediation: buildRemediation(counts, plan.duplicateExternalIds, rowPlans),
    };
  }

  /** Parse then plan or apply, per the request's `dryRun` flag. */
  async run(request: ImportRequest): Promise<ImportPlan> {
    const format = request.format ?? 'json';
    const rows = parsePayload(format, request.payload);
    // Default to a dry run: writing requires an explicit opt-out.
    const dryRun = request.dryRun !== false;
    return dryRun
      ? this.plan(format, rows, request.maxRows)
      : this.apply(format, rows, request.maxRows);
  }
}

function buildRemediation(
  counts: ImportCounts,
  duplicateExternalIds: string[],
  rows: ImportRowPlan[]
): string[] {
  const remediation: string[] = [];

  if (duplicateExternalIds.length > 0) {
    remediation.push(
      `Fix ${duplicateExternalIds.length} duplicated externalId(s) in the file: ${duplicateExternalIds.join(', ')}. ` +
        'Each externalId may appear once per file; the later row was rejected.'
    );
  }

  if (counts.error > 0) {
    const firstFew = rows
      .filter((r) => r.action === 'error')
      .slice(0, 5)
      .map((r) => `row ${r.row}: ${r.reason}`);
    remediation.push(
      `${counts.error} row(s) failed validation and were not imported. Fix and re-upload the whole file — ` +
        `imports are idempotent, so already-imported rows will be skipped on the retry. First failures: ${firstFew.join(' | ')}`
    );
  }

  if (counts.create + counts.update > 0) {
    remediation.push(
      `Re-running this file is safe: rows with an externalId are matched against existing invoices ` +
        `(${counts.skip} would be skipped as unchanged).`
    );
  }

  return remediation;
}

export default ImportService;
