import { generateInvoiceMemo } from '../utils/memo';
import { CreateInvoiceInput } from '../utils/validation';
import memoryStorage, { MemoryStorage } from '../storage/memory-storage';
import { calculateInvoiceExpiry } from '../domain/invoice-expiry';
import type { StoredInvoice } from '../storage/invoice-storage';
import { compareNewestFirst, isAfterCursor, type InvoiceCursor } from '../storage/invoice-cursor';
import type { InvoiceStats } from '../storage/invoice-stats';
import type { PayerInfo } from '../storage/invoice-storage';
import { checkVersion } from '../concurrency/optimistic-lock';

export interface BoundedCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

/**
 * Bounded LRU cache with TTL-based stale detection and explicit invalidation.
 *
 * - Bounded: evicts least-recently-used entries once maxEntries is exceeded.
 * - Stale detection: an entry older than ttlMs is reported as stale and is
 *   removed on read, so callers never receive outdated data silently.
 * - Explicit invalidation: invalidate(key) and invalidateAll() remove entries
 *   on demand (e.g. after writes).
 */
export class BoundedCache<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(options: BoundedCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string;
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Returns the cached value, or undefined when absent or stale.
   * Stale entries are removed as a side effect.
   */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.isStale(entry)) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  isStaleKey(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && this.isStale(entry);
  }

  invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  private isStale(entry: CacheEntry<T>): boolean {
    return this.now() - entry.storedAt >= this.ttlMs;
  }
}

export class InvoiceMemoryService {
  private readonly invoiceCache: BoundedCache<StoredInvoice>;

  constructor(
    private readonly storage: MemoryStorage = memoryStorage,
    cacheOptions: BoundedCacheOptions = {}
  ) {
    this.invoiceCache = new BoundedCache<StoredInvoice>(cacheOptions);
  }

  async createInvoice(input: CreateInvoiceInput): Promise<StoredInvoice> {
    if (!input.sellerPublicKey) {
      throw new Error('Seller public key is required');
    }

    const memo = generateInvoiceMemo();
    const expiresAt = calculateInvoiceExpiry(input.expiresInDays);

    const invoice = this.storage.createInvoice({
      sellerPublicKey: input.sellerPublicKey,
      sellerName: input.sellerName,
      sellerEmail: input.sellerEmail,
      amount: input.amount,
      assetCode: input.assetCode || 'XLM',
      assetIssuer: input.assetIssuer,
      memo,
      description: input.description,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      expiresAt,
    });

    this.invoiceCache.set(invoice.id, invoice);

    if (process.env.NODE_ENV !== 'test') {
      console.log('✅ Invoice created:', invoice.id);
    }
    return invoice;
  }

  async getInvoiceById(id: string): Promise<StoredInvoice | null> {
    const cached = this.invoiceCache.get(id);
    if (cached) return cached;

    const invoice = this.storage.getInvoiceById(id);
    if (!invoice) {
      this.invoiceCache.invalidate(id);
      return null;
    }
    this.invoiceCache.set(id, invoice);
    return invoice;
  }

  async getInvoiceByMemo(memo: string): Promise<StoredInvoice | null> {
    const invoice = this.storage.getInvoiceByMemo(memo);
    return invoice ?? null;
  }

  async markAsPaid(
    invoiceId: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: PayerInfo,
    expectedVersion?: number
  ): Promise<StoredInvoice> {
    const existing = this.storage.getInvoiceById(invoiceId);
    if (existing && expectedVersion !== undefined) {
      checkVersion(expectedVersion, existing.version ?? 1);
    }

    // Invalidate before the write so a failed write never leaves a stale entry
    // that masks the persisted state.
    this.invoiceCache.invalidate(invoiceId);
    const invoice = this.storage.markAsPaid(invoiceId, txHash, payerPublicKey, payerInfo, expectedVersion);

    if (!invoice) {
      throw new Error('Invoice not found, expired, or already processed');
    }

    this.invoiceCache.set(invoiceId, invoice);
    console.log('✅ Invoice marked as paid:', invoiceId);
    return invoice;
  }

  async getInvoicesBySeller(
    sellerPublicKey: string,
    status?: string,
    limit: number = 50,
    offset: number = 0,
    after?: InvoiceCursor
  ): Promise<StoredInvoice[]> {
    let invoices = this.storage.getAllInvoices(status ? { status } : undefined);

    if (sellerPublicKey) {
      invoices = invoices.filter((inv) => inv.sellerPublicKey === sellerPublicKey);
    }

    invoices.sort(compareNewestFirst);
    if (after) invoices = invoices.filter((inv) => isAfterCursor(inv, after));

    return invoices.slice(offset, offset + limit);
  }

  async cancelInvoice(invoiceId: string, expectedVersion?: number): Promise<StoredInvoice> {
    const invoice = this.storage.getInvoiceById(invoiceId);

    if (!invoice) {
      throw new Error('Invoice not found or already processed');
    }

    if (expectedVersion !== undefined) {
      checkVersion(expectedVersion, invoice.version ?? 1);
    }

    if (invoice.status !== 'PENDING') {
      throw new Error('Invoice not found or already processed');
    }

    this.invoiceCache.invalidate(invoiceId);
    const updated = this.storage.updateInvoice(invoiceId, { status: 'CANCELLED' }, expectedVersion);
    if (!updated) {
      throw new Error('Invoice not found or already processed');
    }
    this.invoiceCache.set(invoiceId, updated);
    return updated;
  }

  async findOverduePendingInvoices(cutoff: Date, limit: number) {
    const overdue = this.storage.findOverduePending(cutoff);
    return { total: overdue.length, invoices: overdue.slice(0, limit) };
  }

  async markExpiredInvoices(now?: Date): Promise<number> {
    const count = this.storage.markExpiredInvoices(now);
    // Bulk status changes can affect any cached entry; drop them all.
    if (count > 0) this.invoiceCache.invalidateAll();
    return count;
  }

  async getInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]> {
    return [this.storage.getStats(sellerPublicKey)];
  }

  async getAllInvoices(filter?: { status?: string }): Promise<StoredInvoice[]> {
    return this.storage.getAllInvoices(filter);
  }

  /** Explicitly drop a cached invoice (e.g. after an out-of-band write). */
  invalidateInvoiceCache(invoiceId?: string): void {
    if (invoiceId === undefined) {
      this.invoiceCache.invalidateAll();
    } else {
      this.invoiceCache.invalidate(invoiceId);
    }
  }
}

export default new InvoiceMemoryService();
