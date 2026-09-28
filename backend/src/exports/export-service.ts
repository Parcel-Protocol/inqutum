export type ExportFormat = 'json' | 'csv';
export type ExportCode =
  | 'EXPORT_READY'
  | 'EXPORT_INVALID_REQUEST'
  | 'EXPORT_RETRYABLE_DEPENDENCY'
  | 'EXPORT_EMPTY';

export interface ExportRequest {
  actorId: string;
  resource: 'invoices' | 'payment_proofs' | 'audit_history';
  format: ExportFormat;
  limit?: number;
}

export interface ExportRepository<T> {
  load(request: ExportRequest): Promise<T[]>;
}

export type ExportResult =
  | { ok: true; code: 'EXPORT_READY'; contentType: string; body: string; count: number }
  | { ok: false; code: Exclude<ExportCode, 'EXPORT_READY'>; message: string; retryable: boolean };

const MAX_EXPORT_LIMIT = 10_000;

export async function buildExport<T extends Record<string, unknown>>(
  repository: ExportRepository<T>,
  request: ExportRequest
): Promise<ExportResult> {
  const validation = validateExportRequest(request);
  if (validation) return validation;

  try {
    const rows = await repository.load({ ...request, limit: request.limit ?? MAX_EXPORT_LIMIT });
    if (rows.length === 0) {
      return { ok: false, code: 'EXPORT_EMPTY', message: 'No export rows matched the request.', retryable: false };
    }
    if (request.format === 'json') {
      return {
        ok: true,
        code: 'EXPORT_READY',
        contentType: 'application/json',
        body: JSON.stringify(rows),
        count: rows.length,
      };
    }
    return {
      ok: true,
      code: 'EXPORT_READY',
      contentType: 'text/csv',
      body: toCsv(rows),
      count: rows.length,
    };
  } catch {
    return {
      ok: false,
      code: 'EXPORT_RETRYABLE_DEPENDENCY',
      message: 'Export dependency is unavailable; retry the export later.',
      retryable: true,
    };
  }
}

function validateExportRequest(request: ExportRequest): ExportResult | undefined {
  if (!request.actorId.trim()) {
    return { ok: false, code: 'EXPORT_INVALID_REQUEST', message: 'actorId is required.', retryable: false };
  }
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_EXPORT_LIMIT)
  ) {
    return { ok: false, code: 'EXPORT_INVALID_REQUEST', message: 'limit must be between 1 and 10000.', retryable: false };
  }
  return undefined;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const headers = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).sort();
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(header => csvCell(row[header])).join(','));
  }
  return lines.join('\n');
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
