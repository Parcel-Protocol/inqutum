import { v4 as uuidv4 } from 'uuid';
import { calculateInvoiceStats } from './invoice-stats';
import type { InvoiceStats } from './invoice-stats';
import { isPendingInvoiceExpired } from '../domain/invoice-expiry';
import type { StoredInvoice } from './invoice-storage';
import { checkVersion } from '../concurrency/optimistic-lock';

type Invoice = StoredInvoice;

export interface MemoryStorageOptions {
  /** Maximum number of invoices retained. Oldest entries are evicted first. Default: 10000. */
  maxEntries?: number;
  /** Age after which a cached read is considered stale. Default: 0 (disabled). */
  staleAfterMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export interface CacheStats {
  size: number;
  maxEntries: number;
  evictions: number;
  invalidations: number;
  staleReads: number;
}

const DEFAULT_MAX_ENTRIES = 10000;

class MemoryStorage {
  private invoices: Map<string, Invoice> = new Map();
  private invoicesByMemo: Map<string, string> = new Map(); // memo -> invoice id
  // Insertion/last-write timestamp per invoice id, used for stale detection.
  private writtenAt: Map<string, number> = new Map();

  private readonly maxEntries: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  private evictions = 0;
  private invalidations = 0;
  private staleReads = 0;

  constructor(options: MemoryStorageOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? 0);
    this.now = options.now ?? (() => Date.now());
  }

  createInvoice(data: Partial<Invoice>): Invoice {
    const id = data.id || uuidv4();
    if (this.invoices.has(id)) {
      throw new Error(`Duplicate invoice ID collision: ${id}`);
    }
    if (data.memo && this.invoicesByMemo.has(data.memo)) {
      throw new Error(`Duplicate invoice memo collision: ${data.memo}`);
    }

    const invoice: Invoice = {
      id,
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
      version: 1,
    };

    this.setEntry(invoice);

    if (process.env.NODE_ENV !== 'test') {
      console.log('✅ Invoice created in memory:', invoice.id);
    }
    return invoice;
  }

  // Get invoice by ID
  getInvoiceById(id: string): Invoice | undefined {
    this.markExpiredInvoices();
    return this.readEntry(id);
  }

  // Get invoice by memo
  getInvoiceByMemo(memo: string): Invoice | undefined {
    this.markExpiredInvoices();
    const id = this.invoicesByMemo.get(memo);
    return id ? this.readEntry(id) : undefined;
  }

  // Update invoice
  updateInvoice(id: string, updates: Partial<Invoice>, expectedVersion?: number): Invoice | undefined {
    const invoice = this.invoices.get(id);
    if (!invoice) return undefined;

    checkVersion(expectedVersion, invoice.version ?? 1);

    const updated = { ...invoice, ...updates, version: (invoice.version ?? 1) + 1 };
    if (updates.memo !== undefined && updates.memo !== invoice.memo) {
      if (this.invoicesByMemo.has(updates.memo)) {
        throw new Error(`Duplicate invoice memo collision: ${updates.memo}`);
      }
      this.invoicesByMemo.delete(invoice.memo);
    }
    this.setEntry(updated);

    console.log('✅ Invoice updated:', id);
    return updated;
  }

  // Mark as paid
  markAsPaid(
    id: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: { payerName?: string; payerEmail?: string },
    expectedVersion?: number
  ): Invoice | undefined {
    this.markExpiredInvoices();
    const now = new Date();
    const invoice = this.invoices.get(id);
    if (!invoice || invoice.status !== 'PENDING') return undefined;
    if (new Date(invoice.expiresAt).getTime() <= now.getTime()) return undefined;

    for (const existing of this.invoices.values()) {
      if (existing.id !== id && existing.paymentTxHash && existing.paymentTxHash === txHash) {
        throw new Error(`Duplicate payment_tx_hash collision: ${txHash}`);
      }
    }

    return this.updateInvoice(id, {
      status: 'PAID',
      paymentTxHash: txHash,
      payerPublicKey,
      payerName: payerInfo?.payerName,
      payerEmail: payerInfo?.payerEmail,
      paidAt: new Date(),
    }, expectedVersion);
  }

  // Get all invoices
  getAllInvoices(filter?: { status?: string }): Invoice[] {
    this.markExpiredInvoices();
    let invoices = Array.from(this.invoices.values());

    if (filter?.status) {
      invoices = invoices.filter(inv => inv.status === filter.status);
    }

    return invoices.sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    );
  }

  // Get stats
  getStats(sellerPublicKey: string): InvoiceStats {
    this.markExpiredInvoices();
    return calculateInvoiceStats(Array.from(this.invoices.values()), sellerPublicKey);
  }

  /** Overdue PENDING invoices, without transitioning them. */
  findOverduePending(cutoff: Date): Invoice[] {
    return Array.from(this.invoices.values())
      .filter((invoice) => isPendingInvoiceExpired(invoice, cutoff))
      .sort((a, b) =>
        a.expiresAt.getTime() - b.expiresAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
  }

  // Mark expired invoices
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

  /**
   * Explicitly invalidate a single cached invoice. Returns true if it was present.
   * Does not change invoice data; subsequent reads re-fetch from the backing map.
   */
  invalidate(id: string): boolean {
    const invoice = this.invoices.get(id);
    if (!invoice) return false;
    this.removeEntry(id, invoice);
    this.invalidations++;
    return true;
  }

  /** Invalidate every cached invoice. */
  invalidateAll(): number {
    const count = this.invoices.size;
    this.invoices.clear();
    this.invoicesByMemo.clear();
    this.writtenAt.clear();
    this.invalidations += count;
    return count;
  }

  /** Whether the entry for `id` is older than `staleAfterMs`. Missing entries are not stale. */
  isStale(id: string): boolean {
    if (this.staleAfterMs <= 0) return false;
    const written = this.writtenAt.get(id);
    if (written === undefined) return false;
    return this.now() - written > this.staleAfterMs;
  }

  getCacheStats(): CacheStats {
    return {
      size: this.invoices.size,
      maxEntries: this.maxEntries,
      evictions: this.evictions,
      invalidations: this.invalidations,
      staleReads: this.staleReads,
    };
  }

  // Clear all data (for testing)
  clear() {
    this.invoices.clear();
    this.invoicesByMemo.clear();
    this.writtenAt.clear();
    console.log('🗑️ Memory storage cleared');
  }

  // Get size
  size(): number {
    return this.invoices.size;
  }

  private setEntry(invoice: Invoice): void {
    if (!this.invoices.has(invoice.id)) {
      this.evictIfFull();
    } else {
      // Refresh insertion order so the entry is treated as recently written.
      this.invoices.delete(invoice.id);
    }
    this.invoices.set(invoice.id, invoice);
    this.invoicesByMemo.set(invoice.memo, invoice.id);
    this.writtenAt.set(invoice.id, this.now());
  }

  /** Read an entry, counting stale hits. Stale entries are still returned but flagged via isStale(). */
  private readEntry(id: string): Invoice | undefined {
    const invoice = this.invoices.get(id);
    if (invoice && this.isStale(id)) {
      this.staleReads++;
    }
    return invoice;
  }

  private removeEntry(id: string, invoice: Invoice): void {
    this.invoices.delete(id);
    if (this.invoicesByMemo.get(invoice.memo) === id) {
      this.invoicesByMemo.delete(invoice.memo);
    }
    this.writtenAt.delete(id);
  }

  private evictIfFull(): void {
    while (this.invoices.size >= this.maxEntries) {
      const oldestId = this.invoices.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      const oldest = this.invoices.get(oldestId);
      if (oldest) this.removeEntry(oldestId, oldest);
      this.evictions++;
    }
  }
}

export { MemoryStorage };
export default new MemoryStorage();
