import { v4 as uuidv4 } from 'uuid';
import { calculateInvoiceStats } from './invoice-stats';
import type { InvoiceStats } from './invoice-stats';
import { isPendingInvoiceExpired } from '../domain/invoice-expiry';
import type { StoredInvoice } from './invoice-storage';

type Invoice = StoredInvoice;

class MemoryStorage {
  private invoices: Map<string, Invoice> = new Map();
  private invoicesByMemo: Map<string, string> = new Map(); // memo -> invoice id
  private invoicesByExternalId: Map<string, string> = new Map(); // external_id -> invoice id (issue #53)

  createInvoice(data: Partial<Invoice>): Invoice {
    const invoice: Invoice = {
      id: data.id || uuidv4(),
      sellerPublicKey: data.sellerPublicKey!,
      sellerName: data.sellerName,
      sellerEmail: data.sellerEmail,
      amount: data.amount!,
      assetCode: data.assetCode || 'XLM',
      assetIssuer: data.assetIssuer,
      memo: data.memo!,
      description: data.description,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: data.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      metadata: data.metadata,
      externalId: data.externalId,
    };

    this.invoices.set(invoice.id, invoice);
    this.invoicesByMemo.set(invoice.memo, invoice.id);
    if (invoice.externalId) {
      this.invoicesByExternalId.set(invoice.externalId, invoice.id);
    }

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

  /**
   * Get invoice by import key (issue #53). Intentionally skips
   * `markExpiredInvoices()` so import dry runs stay write-free, matching
   * `getInvoiceByExternalId` on the Postgres backend.
   */
  getInvoiceByExternalId(externalId: string): Invoice | undefined {
    const id = this.invoicesByExternalId.get(externalId);
    return id ? this.invoices.get(id) : undefined;
  }

  /**
   * Descriptive-field patch only (issue #53). Mirrors the Postgres backend:
   * amount, asset, seller, status and payment columns are not patchable.
   */
  updateInvoiceMutableFields(
    id: string,
    patch: {
      description?: string;
      customerName?: string;
      customerEmail?: string;
      sellerName?: string;
      sellerEmail?: string;
    }
  ): Invoice | undefined {
    const allowed: Array<keyof typeof patch> = [
      'description',
      'customerName',
      'customerEmail',
      'sellerName',
      'sellerEmail',
    ];
    const updates: Partial<Invoice> = {};
    for (const field of allowed) {
      if (patch[field] !== undefined) {
        (updates as Record<string, unknown>)[field] = patch[field];
      }
    }
    return this.updateInvoice(id, updates);
  }

  // Update invoice
  updateInvoice(id: string, updates: Partial<Invoice>): Invoice | undefined {
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;

    const updated = { ...invoice, ...updates };
    this.invoices.set(id, updated);

    console.log('✅ Invoice updated:', id);
    return updated;
  }

  // Mark as paid
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: { payerName?: string; payerEmail?: string }
  ): Invoice | undefined {
    this.markExpiredInvoices();
    const now = new Date();
    const invoice = this.invoices.get(id);
    if (!invoice || invoice.status !== 'PENDING') return undefined;
    if (new Date(invoice.expiresAt).getTime() <= now.getTime()) return undefined;

    return this.updateInvoice(id, {
      status: 'PAID',
      paymentTxHash: txHash,
      payerPublicKey,
      payerName: payerInfo?.payerName,
      payerEmail: payerInfo?.payerEmail,
      paidAt: new Date(),
    });
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
  /** Overdue PENDING invoices, without transitioning them. */
  findOverduePending(cutoff: Date): Invoice[] {
    return Array.from(this.invoices.values())
      .filter((invoice) => isPendingInvoiceExpired(invoice, cutoff))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  }

  markExpiredInvoices(now: Date = new Date()): number {
    let count = 0;

    this.invoices.forEach((invoice) => {
      if (isPendingInvoiceExpired(invoice, now)) {
        invoice.status = 'EXPIRED';
        count++;
      }
    });

    if (count > 0) {
      console.log(`⏰ Marked ${count} invoices as expired`);
    }

    return count;
  }

  // Clear all data (for testing)
  clear() {
    this.invoices.clear();
    this.invoicesByMemo.clear();
    this.invoicesByExternalId.clear();
    console.log('🗑️ Memory storage cleared');
  }

  // Get size
  size(): number {
    return this.invoices.size;
  }
}

export { MemoryStorage };
export default new MemoryStorage();
