// Keyset pagination for invoice lists. Rows are ordered newest first by
// (createdAt ms, id) — id breaks ties so the order is total and a cursor
// always points between two exact rows, regardless of inserts or status
// changes happening while a client pages.
//
// Bounded cache with explicit invalidation and stale detection
// --------------------------------------------------------------
// `InvoiceCursorCache` memoizes decoded cursors so hot pagination paths do not
// repeatedly base64/regex-parse the same opaque token. The cache is:
//   - bounded: at most `maxEntries` entries; least-recently-used entries are
//     evicted first (Map insertion order is used as the LRU queue);
//   - explicitly invalidatable: `invalidate(key)` / `clear()` drop entries, and
//     `invalidateBefore(ms)` drops every entry whose cursor createdAt is older
//     than a watermark (used when a backend reindexes or a retention job runs);
//   - stale-aware: each entry records the time it was stored. Entries older than
//     `ttlMs` are treated as stale: `get` returns undefined, removes the entry,
//     and increments the `staleEvictions` counter so operators can observe it.
//
// Failure/authorization behaviour: the cache stores only successfully decoded
// cursors. Invalid tokens are never cached (so a malformed or forged value
// cannot pin memory), and the cache does not make authorization decisions —
// callers must still scope queries to the requesting tenant after decoding.
// Retry: `decodeInvoiceCursor` is pure and idempotent, so retries are safe.
// Rollback: the cache is an optional layer; `decodeInvoiceCursor` remains the
// source of truth and can be called directly by disabling the cache instance.

export interface InvoiceCursor {
  /** createdAt truncated to milliseconds (Postgres compares at the same precision). */
  createdAt: Date;
  id: string;
}

export interface CursorValidationResult {
  valid: boolean;
  cursor: InvoiceCursor | null;
  errorCode?: 'INVALID_CURSOR';
  errorMessage?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeInvoiceCursor(invoice: { createdAt: Date | string | number; id: string }): string {
  if (!invoice || typeof invoice !== 'object') {
    throw new TypeError('Cannot encode cursor: invoice must be an object');
  }

  const rawId = typeof invoice.id === 'string' ? invoice.id.trim() : '';
  if (!rawId || !UUID.test(rawId)) {
    throw new TypeError(`Cannot encode cursor: invalid invoice id "${invoice.id}"`);
  }

  const date = invoice.createdAt instanceof Date ? invoice.createdAt : new Date(invoice.createdAt);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Cannot encode cursor: invalid createdAt date "${invoice.createdAt}"`);
  }

  const raw = `${date.toISOString()}|${rawId.toLowerCase()}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this server issued. */
export function decodeInvoiceCursor(value: unknown): InvoiceCursor | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || !BASE64URL_PATTERN.test(trimmed)) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split('|');
  if (parts.length !== 2) return null;

  const [iso, id] = parts;
  if (!id || !UUID.test(id) || !iso || !ISO_DATE_PATTERN.test(iso)) return null;

  const createdAt = new Date(iso);
  if (!Number.isFinite(createdAt.getTime())) return null;

  const isoNormalized = createdAt.toISOString();
  if (isoNormalized !== iso && isoNormalized.replace(/\.000Z$/, 'Z') !== iso) {
    return null;
  }

  return { createdAt, id: id.toLowerCase() };
}

/** Validates an incoming cursor string against the stable server contract. */
export function validateInvoiceCursor(value: unknown): CursorValidationResult {
  const cursor = decodeInvoiceCursor(value);
  if (!cursor) {
    return {
      valid: false,
      cursor: null,
      errorCode: 'INVALID_CURSOR',
      errorMessage: 'cursor is not valid; restart from the first page',
    };
  }
  return { valid: true, cursor };
}

export interface InvoiceCursorCacheOptions {
  /** Maximum number of decoded cursors retained. Must be a positive integer. */
  maxEntries: number;
  /** Entries older than this many milliseconds are stale and are not served. */
  ttlMs: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export interface InvoiceCursorCacheStats {
  size: number;
  hits: number;
  misses: number;
  staleEvictions: number;
  capacityEvictions: number;
}

interface CacheEntry {
  cursor: InvoiceCursor;
  storedAt: number;
}

/**
 * Bounded LRU cache of decoded invoice cursors with TTL-based stale detection
 * and explicit invalidation. Only successfully decoded cursors are stored.
 */
export class InvoiceCursorCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private staleEvictions = 0;
  private capacityEvictions = 0;

  constructor(options: InvoiceCursorCacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError('InvoiceCursorCache: maxEntries must be a positive integer');
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError('InvoiceCursorCache: ttlMs must be a non-negative finite number');
    }
    this.maxEntries = options.maxEntries;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Decodes a cursor string, serving from cache when a fresh entry exists.
   * Invalid input returns null and is never cached.
   */
  decode(value: unknown): InvoiceCursor | null {
    if (typeof value !== 'string') return null;
    const key = value.trim();

    const cached = this.getFresh(key);
    if (cached) return cached;

    const cursor = decodeInvoiceCursor(value);
    if (!cursor) return null;

    this.store(key, cursor);
    return cursor;
  }

  /** Removes a single cached token. Returns true if an entry was removed. */
  invalidate(value: string): boolean {
    return this.entries.delete(value.trim());
  }

  /**
   * Removes every entry whose cursor position is strictly older than the
   * watermark (epoch ms). Used when rows older than the watermark are purged or
   * reindexed and cursors pointing at them must not be trusted from cache.
   */
  invalidateBefore(watermarkMs: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.cursor.createdAt.getTime() < watermarkMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Drops all entries. Counters are preserved for observability. */
  clear(): void {
    this.entries.clear();
  }

  stats(): InvoiceCursorCacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      staleEvictions: this.staleEvictions,
      capacityEvictions: this.capacityEvictions,
    };
  }

  private getFresh(key: string): InvoiceCursor | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.staleEvictions++;
      this.misses++;
      return null;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.cursor;
  }

  private store(key: string, cursor: InvoiceCursor): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { cursor, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.capacityEvictions++;
    }
  }
}

/** Newest first, then id descending — the one ordering every backend uses. */
export function compareNewestFirst(
  a: { createdAt: Date | string | number; id: string },
  b: { createdAt: Date | string | number; id: string }
): number {
  const timeA =
    a?.createdAt instanceof Date
      ? a.createdAt.getTime()
      : typeof a?.createdAt === 'number'
        ? a.createdAt
        : new Date(a?.createdAt).getTime();

  const timeB =
    b?.createdAt instanceof Date
      ? b.createdAt.getTime()
      : typeof b?.createdAt === 'number'
        ? b.createdAt
        : new Date(b?.createdAt).getTime();

  const safeA = Number.isFinite(timeA) ? timeA : 0;
  const safeB = Number.isFinite(timeB) ? timeB : 0;

  const byTime = safeB - safeA;
  if (byTime !== 0) return byTime;

  const idA = String(a?.id ?? '').toLowerCase();
  const idB = String(b?.id ?? '').toLowerCase();
  return idA < idB ? 1 : idA > idB ? -1 : 0;
}

/** True when the invoice sorts strictly after the cursor position. */
export function isAfterCursor(
  invoice: { createdAt: Date | string | number; id: string },
  cursor: InvoiceCursor
): boolean {
  if (!invoice || !cursor) return false;
  return compareNewestFirst(cursor, invoice) < 0;
}
