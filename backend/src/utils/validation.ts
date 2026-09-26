import { z } from 'zod';
import {
  DEFAULT_INVOICE_EXPIRY_DAYS,
  MAX_INVOICE_EXPIRY_DAYS,
  MIN_INVOICE_EXPIRY_DAYS,
} from '../domain/invoice-expiry';
import { NATIVE_ASSET_CODE, requiresIssuer } from './asset-helpers';
import { sanitizePlainText } from '../security/content-safety';

// Schemas used identically by both servers. Zod validates the create+verify
// payloads before they ever reach the InvoiceStorage layer, so the memory
// and Postgres backends receive the same seller name/email, assetCode +
// assetIssuer, customer name/email, expiresInDays and metadata fields.
// Stellar public key validation
export const stellarPublicKeySchema = z.string()
  .length(56)
  .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format');

/**
 * Invoice creation schema.
 *
 * A credit asset must carry its issuer (issue #246). Without one the invoice
 * names an asset nobody pinned, which verification refuses to settle — so
 * accepting it at creation would only produce an invoice that can never be
 * paid. `XLM` is the exception: it is the native asset and has no issuer.
 */
/**
 * Free-text fields are length-checked as submitted, then stripped of markup,
 * control and bidi characters. A value that is empty after stripping is dropped.
 */
const plainText = (max: number, multiline = false) =>
  z
    .string()
    .max(max)
    .transform((value) => sanitizePlainText(value, { multiline }) || undefined);

/**
 * Caller-supplied import key (issue #53).
 *
 * Bounded to the `invoices.external_id VARCHAR(255)` column and restricted to
 * printable characters so a key can be echoed into remediation messages and
 * compared without normalisation surprises. Matching is case-SENSITIVE, which
 * matches the case-sensitive partial unique index in db/schema.sql: `INV-1`
 * and `inv-1` are two different keys. Callers that need case-insensitive
 * identity should normalise before importing.
 */
const externalIdSchema = z
  .string()
  .trim()
  .min(1, 'externalId must not be empty')
  .max(255, 'externalId must be at most 255 characters')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'externalId must not contain control characters',
  });

/**
 * Shape shared by the create-invoice and import-row schemas.
 *
 * `externalId` lives here rather than only on the import schema because the
 * import pipeline reuses `createInvoice` for the write; keeping one shape means
 * an imported invoice is validated by exactly the same rules as one created
 * through `POST /invoices`. The HTTP create route also accepts the field, so a
 * caller can claim an import key for a single invoice; updates are limited to
 * descriptive fields, so a claimed key cannot rewrite amounts or ownership.
 */
const invoiceShape = {
  amount: z.number().positive().max(1000000000),
  assetCode: z.string().default('XLM').optional(),
  assetIssuer: stellarPublicKeySchema.optional(),
  description: plainText(500, true).optional(),
  customerName: plainText(255).optional(),
  customerEmail: z.string().email().optional(),
  sellerName: plainText(255).optional(),
  sellerEmail: z.string().email().optional(),
  expiresInDays: z.number()
    .int()
    .min(MIN_INVOICE_EXPIRY_DAYS)
    .max(MAX_INVOICE_EXPIRY_DAYS)
    .default(DEFAULT_INVOICE_EXPIRY_DAYS),
  sellerPublicKey: stellarPublicKeySchema,
  externalId: externalIdSchema.optional(),
};

/** A credit asset must name its issuer; XLM is native and must not. */
const requiresMatchingIssuer = (invoice: { assetCode?: string; assetIssuer?: string }) =>
  !requiresIssuer(invoice.assetCode) || Boolean(invoice.assetIssuer);
const nativeHasNoIssuer = (invoice: { assetCode?: string; assetIssuer?: string }) =>
  invoice.assetCode !== NATIVE_ASSET_CODE || !invoice.assetIssuer;

export const createInvoiceSchema = z
  .object(invoiceShape)
  .refine(requiresMatchingIssuer, {
    path: ['assetIssuer'],
    message:
      'assetIssuer is required for issued assets; only XLM may omit it. An asset is identified by its code and issuer together.',
  })
  .refine(nativeHasNoIssuer, {
    path: ['assetIssuer'],
    message: 'XLM is the native asset and must not carry an issuer.',
  });

/**
 * One row of a bulk import file (issue #53).
 *
 * Identical to `createInvoiceSchema`, exported separately so the import
 * pipeline and its tests can name the row type without implying a different
 * validation contract. Reuses the same two asset refinements, so an imported
 * row can never name an asset the create endpoint would have rejected.
 */
export const importRowSchema = z
  .object(invoiceShape)
  .refine(requiresMatchingIssuer, {
    path: ['assetIssuer'],
    message:
      'assetIssuer is required for issued assets; only XLM may omit it. An asset is identified by its code and issuer together.',
  })
  .refine(nativeHasNoIssuer, {
    path: ['assetIssuer'],
    message: 'XLM is the native asset and must not carry an issuer.',
  });

// Payment verification schema
export const paymentSchema = z.object({
  invoiceId: z.string().uuid(),
  txHash: z.string().length(64),
  payerPublicKey: stellarPublicKeySchema,
  amount: z.number().positive(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;

export default {
  createInvoiceSchema,
  importRowSchema,
  paymentSchema,
  stellarPublicKeySchema,
};
