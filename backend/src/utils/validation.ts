import { z } from 'zod';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  DEFAULT_INVOICE_EXPIRY_DAYS,
  MAX_INVOICE_EXPIRY_DAYS,
  MIN_INVOICE_EXPIRY_DAYS,
} from '../domain/invoice-expiry';
import { NATIVE_ASSET_CODE, requiresIssuer } from './asset-helpers';
import { SUPPORTED_STELLAR_NETWORKS } from '../config/stellar';

// Schemas used identically by both servers. Zod validates the create+verify
// payloads before they ever reach the InvoiceStorage layer, so the memory
// and Postgres backends receive the same seller name/email, assetCode +
// assetIssuer, customer name/email, expiresInDays and metadata fields.
// Rejections are serialized through the shared failure envelope
// (`{ success:false, error }`) from types/api.ts, matching the verify path's
// `code` + `error` shape so every client reads one consistent contract.
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
 * Issuer of a credit asset (issue #8): a well-formed Ed25519 strkey, including
 * its checksum. Case is NOT normalized: strkeys are canonical uppercase base32
 * and a key in any other case is a different (invalid) string, so it is
 * rejected rather than "fixed".
 */
export const assetIssuerSchema = stellarPublicKeySchema.refine(
  (key) => StellarSdk.StrKey.isValidEd25519PublicKey(key),
  'Invalid Stellar issuer key (checksum failed)',
);

/**
 * Asset code as typed by a seller (issue #8). This is the friendly half of the
 * create/verify split: surrounding whitespace is trimmed and the code is
 * uppercased ("usdc" -> "USDC", the Stellar convention), then checked against
 * the protocol's 1-12 character alphanumeric shape. Verification, by contrast,
 * compares the stored code and issuer byte-for-byte with no normalization.
 */
export const assetCodeSchema = z
  .string()
  .transform((code) => code.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{1,12}$/, 'Asset code must be 1-12 letters or digits'));

export const createInvoiceSchema = z
  .object({
    amount: z.number().positive().max(1000000000),
    assetCode: assetCodeSchema.default('XLM').optional(),
    assetIssuer: assetIssuerSchema.optional(),
    description: z.string().max(500).optional(),
    customerName: z.string().max(255).optional(),
    customerEmail: z.string().email().optional(),
    sellerName: z.string().max(255).optional(),
    sellerEmail: z.string().email().optional(),
    network: z.enum(SUPPORTED_STELLAR_NETWORKS).optional(),
    expiresInDays: z.number()
      .int()
      .min(MIN_INVOICE_EXPIRY_DAYS)
      .max(MAX_INVOICE_EXPIRY_DAYS)
      .default(DEFAULT_INVOICE_EXPIRY_DAYS),
    sellerPublicKey: stellarPublicKeySchema,
  })
  .refine(
    (invoice) => !requiresIssuer(invoice.assetCode) || Boolean(invoice.assetIssuer),
    {
      path: ['assetIssuer'],
      message:
        'assetIssuer is required for issued assets; only XLM may omit it. An asset is identified by its code and issuer together.',
    },
  )
  .refine(
    (invoice) => invoice.assetCode !== NATIVE_ASSET_CODE || !invoice.assetIssuer,
    {
      path: ['assetIssuer'],
      message: 'XLM is the native asset and must not carry an issuer.',
    },
  );

// Payment verification schema
export const paymentSchema = z.object({
  invoiceId: z.string().uuid(),
  txHash: z.string().length(64),
  payerPublicKey: stellarPublicKeySchema,
  amount: z.number().positive(),
});

// Invoice cancellation schema
export const cancelInvoiceSchema = z.object({
  sellerPublicKey: stellarPublicKeySchema.optional(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;

export default {
  createInvoiceSchema,
  paymentSchema,
  cancelInvoiceSchema,
  stellarPublicKeySchema,
};
