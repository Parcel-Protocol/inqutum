import { v4 as uuidv4 } from 'uuid';
import { calculateInvoiceStats } from './invoice-stats';
import type { InvoiceStats } from './invoice-stats';
import { isPendingInvoiceExpired } from '../domain/invoice-expiry';
import { settlementFieldsForInvoice } from '../domain/invoice-settlement';
import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
} from '../../../shared/invoice-lifecycle';
import type { InvoiceEvent } from '../../../shared/invoice-lifecycle';
import {
  MemoCollisionError,
  PaymentClaimError,
  PaymentClaimIndex,
} from '../domain/payment-attribution';
import type { PaymentClaim } from '../domain/payment-attribution';
import type { AuditEvent, MarkAsPaidOptions, StoredInvoice } from './invoice-storage';

export interface MemoryPaymentEvent {
  id: string;
  invoiceId: string;
  eventType: string;
  eventData: any;
  createdAt: Date;
}

type Invoice = StoredInvoice;

class MemoryStorage {
  private invoices: Map<string, Invoice> = new Map();
  private invoicesByMemo: Map<string, string> = new Map(); // memo -> invoice id
  // Which invoice each transaction hash settled; see domain/payment-attribution.ts.
  private readonly paymentClaims = new PaymentClaimIndex();
  private paymentEvents: MemoryPaymentEvent[] = [];
  // State-change events (created / cancelled / expired). Kept apart from
  // paymentEvents, which callers read as "payment activity only"; the audit
  // trail below presents the two as one ordered history.
  private lifecycleEvents: MemoryPaymentEvent[] = [];

  createInvoice(data: Partial<Invoice>): Invoice {
    const invoice: Invoice = {
      id: data.id || uuidv4(),
      sellerPublicKey: data.sellerPublicKey!,
      sellerName: data.sellerName,
      sellerEmail: data.sellerEmail,
      amount: data.amount!,
      assetCode: (data.assetCode || 'XLM').toUpperCase(),
      assetIssuer: data.assetIssuer,
      memo: data.memo!,
      description: data.description,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: data.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      metadata: data.metadata,
    };

    // The memo index is keyed by memo, so a second invoice carrying the same
    // memo would overwrite the first one's entry and leave it unreachable by
    // the payment monitor. Refuse instead, and let creation draw another memo.
    if (this.invoicesByMemo.has(invoice.memo)) {
      throw new MemoCollisionError(invoice.memo);
    }

    this.invoices.set(invoice.id, invoice);
    this.invoicesByMemo.set(invoice.memo, invoice.id);
    this.recordLifecycleEvent(invoice.id, 'INVOICE_CREATED', { to: 'PENDING' });

    console.log('✅ Invoice created in memory:', invoice.id);
    return invoice;
  }

  // Get invoice by ID
  getInvoiceById(id: string): Invoice | undefined {
    this.markExpiredInvoices();
    return this.invoices.get(id);
  }

  // Get invoice by memo
  getInvoiceByMemo(memo: string): Invoice | undefined {
    this.markExpiredInvoices();
    const id = this.invoicesByMemo.get(memo);
    return id ? this.invoices.get(id) : undefined;
  }

  /** Read-only memo lookup, without the expiry sweep getInvoiceByMemo runs. */
  hasMemo(memo: string): boolean {
    return this.invoicesByMemo.has(memo);
  }

  /** Read-only claim lookup, for diagnostics and tests. */
  getPaymentClaim(txHash: string): PaymentClaim | undefined {
    return this.paymentClaims.peek(txHash);
  }

  // Update invoice
  updateInvoice(id: string, updates: Partial<Invoice>): Invoice | undefined {
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;

    // Last line of defence: whatever the caller intended, a status write that
    // the lifecycle does not allow never reaches the record.
    if (updates.status && updates.status !== invoice.status && !canTransition(invoice.status, updates.status)) {
      throw new InvalidTransitionError(invoice.status, updates.status);
    }

    const updated = { ...invoice, ...updates };
    this.invoices.set(id, updated);

    console.log('✅ Invoice updated:', id);
    return updated;
  }

  // Cancel invoice
  cancelInvoice(id: string, sellerPublicKey?: string): Invoice | undefined {
    this.markExpiredInvoices();
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;
    if (sellerPublicKey && invoice.sellerPublicKey !== sellerPublicKey) {
      throw new Error('Unauthorized: only the seller can cancel this invoice');
    }
    const to = assertTransition(invoice.status, 'CANCEL');
    const updated = this.updateInvoice(id, { status: to, cancelledAt: new Date() });
    if (updated) {
      this.recordLifecycleEvent(id, 'INVOICE_CANCELLED', {
        from: invoice.status,
        to,
        actor: sellerPublicKey,
      });
    }
    return updated;
  }

  // Mark as paid
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: { payerName?: string; payerEmail?: string },
    options: MarkAsPaidOptions = {}
  ): Invoice | undefined {
    this.markExpiredInvoices();
    const now = new Date();
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;
    // PENDING settles on time, CANCELLED settles late; every other state
    // (PAID, EXPIRED) is refused by the lifecycle, so a replay or a payment
    // that lost the race to expiry is rejected the same way in every store.
    const event: InvoiceEvent = invoice.status === 'CANCELLED' ? 'SETTLE_AFTER_CANCEL' : 'SETTLE';
    const to = assertTransition(invoice.status, event);
    if (invoice.status === 'PENDING' && new Date(invoice.expiresAt).getTime() <= now.getTime()) {
      throw new InvalidTransitionError('EXPIRED', to, event);
    }

    const settlement = settlementFieldsForInvoice(
      invoice,
      options.settledAt ?? (invoice.status === 'PENDING' ? now : undefined)
    );

    // One transaction settles one invoice. The claim below reads and records in
    // the same synchronous step, so a second caller holding the same hash gets a
    // decision here rather than a second PAID transition. A replay against this
    // same invoice falls back to the "already processed" contract above.
    const decision = this.paymentClaims.claim(txHash, id, now);
    if (decision.kind === 'conflict') {
      throw new PaymentClaimError(txHash, id, decision.claim.invoiceId);
    }
    if (decision.kind === 'replay') return undefined;

    const updated = this.updateInvoice(id, {
      status: to,
      paymentTxHash: txHash,
      payerPublicKey,
      payerName: payerInfo?.payerName,
      payerEmail: payerInfo?.payerEmail,
      paidAt: now,
      cancelledAt: invoice.cancelledAt,
      settledAt: settlement.settledAt,
      settlementContext: settlement.settlementContext,
      priorStatus: settlement.priorStatus,
      latePaymentWarningCode: settlement.latePaymentWarningCode,
    });

    if (updated) {
      this.logPaymentEvent(id, 'PAYMENT_CONFIRMED', {
        txHash,
        payerPublicKey,
        settledAt: settlement.settledAt.toISOString(),
        settlementContext: settlement.settlementContext,
        priorStatus: settlement.priorStatus,
        latePaymentWarningCode: settlement.latePaymentWarningCode,
      });
    }

    return updated;
  }

  // Get all invoices
  getAllInvoices(filter?: { status?: string }): Invoice[] {
    this.markExpiredInvoices();
    let invoices = Array.from(this.invoices.values());

    if (filter?.status) {
      invoices = invoices.filter(inv => inv.status === filter.status);
    }

    return invoices.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // Get stats
  getStats(sellerPublicKey: string): InvoiceStats {
    this.markExpiredInvoices();
    return calculateInvoiceStats(Array.from(this.invoices.values()), sellerPublicKey);
  }

  // Mark expired invoices
  markExpiredInvoices(now: Date = new Date()): number {
    let count = 0;

    this.invoices.forEach((invoice) => {
      if (isPendingInvoiceExpired(invoice, now)) {
        const from = invoice.status;
        invoice.status = assertTransition(from, 'EXPIRE');
        this.recordLifecycleEvent(invoice.id, 'INVOICE_EXPIRED', { from, to: invoice.status });
        count++;
      }
    });

    if (count > 0) {
      console.log(`⏰ Marked ${count} invoices as expired`);
    }

    return count;
  }

  /**
   * Records a payment lifecycle audit event in memory.
   */
  logPaymentEvent(invoiceId: string, eventType: string, eventData: any): void {
    this.paymentEvents.push({
      id: uuidv4(),
      invoiceId,
      eventType,
      eventData,
      createdAt: new Date(),
    });
  }

  /** Records a state change in the audit trail. */
  private recordLifecycleEvent(invoiceId: string, eventType: string, eventData: any): void {
    this.lifecycleEvents.push({
      id: uuidv4(),
      invoiceId,
      eventType,
      eventData,
      createdAt: new Date(),
    });
  }

  /**
   * Full audit trail for one invoice: state changes and payment events in the
   * order they happened. Matches what `payment_events` holds for Postgres.
   */
  getAuditTrail(invoiceId: string): AuditEvent[] {
    return [...this.lifecycleEvents, ...this.paymentEvents]
      .filter((event) => event.invoiceId === invoiceId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((event) => ({ ...event, eventData: event.eventData ?? null }));
  }

  /**
   * Retrieves payment audit events, optionally filtered by invoice ID.
   */
  getPaymentEvents(invoiceId?: string): MemoryPaymentEvent[] {
    if (invoiceId) {
      return this.paymentEvents.filter((event) => event.invoiceId === invoiceId);
    }
    return [...this.paymentEvents];
  }

  // Clear all data (for testing)
  clear() {
    this.invoices.clear();
    this.invoicesByMemo.clear();
    this.paymentClaims.clear();
    this.paymentEvents = [];
    this.lifecycleEvents = [];
    console.log('🗑️ Memory storage cleared');
  }

  // Get size
  size(): number {
    return this.invoices.size;
  }

  countInvoices(): number {
    return this.invoices.size;
  }
}

export { MemoryStorage };
export default new MemoryStorage();
