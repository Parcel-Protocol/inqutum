/**
 * The export column allow-list. Lives in its own module so the field policy and
 * the export service can both depend on it without importing each other.
 */
export const EXPORT_FIELDS = [
  'id',
  'memo',
  'status',
  'amount',
  'assetCode',
  'assetIssuer',
  'description',
  'createdAt',
  'expiresAt',
  'paidAt',
  'paymentTxHash',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];
export type ExportRecord = Record<ExportField, string | number | null>;
