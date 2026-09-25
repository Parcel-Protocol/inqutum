import { CreateInvoiceInput } from '../utils/validation';
import type {
  LatePaymentWarningCode,
  SettlementContext,
} from '../domain/invoice-settlement';
import type { InvoiceStats } from './invoice-stats';
import type {
  ReconciliationInvoice,
  ReconciliationSettlement,
} from '../domain/reconciliation';

// Shared shape and shared storage contract. Both MemoryInvoiceStorage and
// PostgresInvoiceStorage implement these 8 methods with the same semantics,
// and every invoice they return is the StoredInvoice type below. Behaviour
// parity (expiry guard on normal markAsPaid, cancel-aware late settlement,
// single-transition PENDING->CANCELLED, lazy
// markExpiredInvoices on all reads, strict seller_public_key scoping on list
// and stats) is pinned by the shared test suite in invoice-handlers.test.ts.
// The status set and its legal transitions live in shared/invoice-lifecycle.ts;
// both stores and the UI ask that module rather than re-deriving the rules.
import type { InvoiceStatus } from '../../../shared/invoice-lifecycle';
export type { InvoiceStatus };

/**
 * One row of an invoice's audit trail: a state change or payment event that
 * affected the user or their funds. Backed by `payment_events` in Postgres and
 * an in-process list in the memory store.
 */
export interface AuditEvent {
  id: string;
  invoiceId: string;
  eventType: string;
  eventData: Record<string, unknown> | null;
  createdAt: Date;
}

// Invoice shape shared by both storage backends.
export interface StoredInvoice {
  id: string;
  userId?: string;
  sellerPublicKey: string;
  sellerName?: string;
  sellerEmail?: string;
  amount: number;
  /** Asset code for the invoice (e.g., 'XLM' or 'USDC'). */
  assetCode: string;
  /** Issuer public key for credit assets (omitted for native XLM). */
  assetIssuer?: string;
  memo: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
  status: InvoiceStatus;
  paymentTxHash?: string;
  payerPublicKey?: string;
  payerName?: string;
  payerEmail?: string;
  createdAt: Date;
  paidAt?: Date;
  cancelledAt?: Date;
  settledAt?: Date;
  settlementContext?: SettlementContext;
  priorStatus?: InvoiceStatus;
  latePaymentWarningCode?: LatePaymentWarningCode;
  expiresAt: Date;
  metadata?: any;
}

export interface PayerInfo {
  payerName?: string;
  payerEmail?: string;
}

export interface MarkAsPaidOptions {
  /** Horizon ledger close time for the matching transaction. */
  settledAt?: Date;
}

/**
 * Storage adapter the shared invoice handlers run against.
 *
 * Both implementations are wallet-scoped: the seller public key always comes
 * from the invoice input or the caller's query, never from a static env key.
 */
export interface InvoiceStorage {
  /** Reported by /api/health so a running server tells you which backend it uses. */
  readonly mode: string;

  createInvoice(input: CreateInvoiceInput): Promise<StoredInvoice>;
  getInvoiceById(id: string): Promise<StoredInvoice | null>;
  getInvoicesBySeller(
    sellerPublicKey: string,
    status?: string,
    limit?: number,
    offset?: number
  ): Promise<StoredInvoice[]>;
  cancelInvoice(id: string, sellerPublicKey?: string): Promise<StoredInvoice>;
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: PayerInfo,
    options?: MarkAsPaidOptions
  ): Promise<StoredInvoice>;
  getInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]>;
  /** Explicit maintenance hook; reads also apply this transition lazily. */
  markExpiredInvoices(now?: Date): Promise<number>;
  /** Returns total count of invoices currently stored. */
  countInvoices?(): Promise<number>;
  /** Audit events for one invoice, oldest first. */
  getAuditTrail(invoiceId: string): Promise<AuditEvent[]>;

  // --- Read-only access for reconciliation (docs/RECONCILIATION.md) ---
  //
  // Every other read here applies the expiry sweep first, which *writes*. These
  // never write: a reconciliation that changed the data it is checking could
  // not report stale records, and could not be run against production safely.

  /** Every invoice exactly as stored, with amounts kept exact. */
  listInvoicesForReconciliation(): Promise<ReconciliationInvoice[]>;
  /** Every audit event, oldest first. */
  listAuditEvents(): Promise<AuditEvent[]>;
  /** Same figures as getInvoiceStats, without the expiry sweep. */
  readInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]>;
  /** Settlement references held apart from the invoice rows, or null if this backend keeps none. */
  listSettlements(): Promise<ReconciliationSettlement[] | null>;
}
