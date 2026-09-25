// Keyset pagination for invoice lists. Rows are ordered newest first by
// (createdAt ms, id) — id breaks ties so the order is total and a cursor
// always points between two exact rows, regardless of inserts or status
// changes happening while a client pages.

export interface InvoiceCursor {
  /** createdAt truncated to milliseconds (Postgres compares at the same precision). */
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeInvoiceCursor(invoice: { createdAt: Date; id: string }): string {
  const raw = `${new Date(invoice.createdAt).toISOString()}|${invoice.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this server issued. */
export function decodeInvoiceCursor(value: string): InvoiceCursor | null {
  const [iso, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso);
  if (rest.length || !id || !UUID.test(id) || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/** Newest first, then id descending — the one ordering every backend uses. */
export function compareNewestFirst(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string }
): number {
  const byTime = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when the invoice sorts strictly after the cursor position. */
export function isAfterCursor(invoice: { createdAt: Date; id: string }, cursor: InvoiceCursor): boolean {
  return compareNewestFirst(cursor, invoice) < 0;
}
