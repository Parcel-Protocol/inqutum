// A small in-process stand-in for the Postgres `invoices` + `payment_events`
// tables. It understands only the statements InvoiceService issues, matched by
// their leading text like the doubles in the older suites, so SQL parameter
// order and row mapping stay under test without a database.
//
// Unlike those per-file doubles it also keeps the audit rows, which is what the
// lifecycle and reconciliation suites read back.
import type { Queryable } from '../../src/services/invoice.service.ts';

const INSERT_COLUMNS = [
  'id',
  'seller_public_key',
  'seller_name',
  'seller_email',
  'amount',
  'asset_code',
  'asset_issuer',
  'memo',
  'description',
  'customer_name',
  'customer_email',
  'status',
  'expires_at',
];

export interface FakeEventRow {
  id: string;
  invoice_id: string;
  event_type: string;
  event_data: any;
  created_at: Date;
}

export class FakeInvoiceDb implements Queryable {
  rows: Record<string, any>[] = [];
  events: FakeEventRow[] = [];
  private eventSeq = 0;

  async query(text: string, params: any[] = []) {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('INSERT INTO invoices')) {
      const row: Record<string, any> = {
        created_at: new Date(),
        paid_at: null,
        metadata: null,
        payment_tx_hash: null,
        payer_public_key: null,
        payer_name: null,
        payer_email: null,
        cancelled_at: null,
        settled_at: null,
        settlement_context: null,
        prior_status: null,
        late_payment_warning_code: null,
      };
      INSERT_COLUMNS.forEach((column, index) => {
        row[column] = params[index] ?? null;
      });
      // Postgres returns DECIMAL as a string.
      row.amount = String(row.amount);
      this.rows.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'EXPIRED'")) {
      const now = new Date(params[0]).getTime();
      const expired = this.rows.filter(
        (row) => row.status === 'PENDING' && new Date(row.expires_at).getTime() <= now
      );
      expired.forEach((row) => {
        row.status = 'EXPIRED';
      });
      return { rows: expired.map((row) => ({ id: row.id })), rowCount: expired.length };
    }

    if (sql.startsWith('WITH settled AS')) {
      const settledAt = params[5] ? new Date(params[5]) : new Date();
      const row = this.rows.find(
        (candidate) =>
          candidate.id === params[0] &&
          ((candidate.status === 'PENDING' && new Date(candidate.expires_at).getTime() > Date.now()) ||
            (candidate.status === 'CANCELLED' && candidate.cancelled_at && Number.isFinite(settledAt.getTime())))
      );
      if (!row) return { rows: [], rowCount: 0 };
      const afterCancel =
        row.status === 'CANCELLED' && settledAt.getTime() >= new Date(row.cancelled_at).getTime();
      Object.assign(row, {
        prior_status: row.status === 'CANCELLED' ? 'CANCELLED' : null,
        status: 'PAID',
        payment_tx_hash: params[1],
        payer_public_key: params[2],
        payer_name: params[3],
        payer_email: params[4],
        paid_at: new Date(),
        settled_at: settledAt,
        settlement_context: afterCancel ? 'AFTER_CANCEL' : 'ON_TIME',
        late_payment_warning_code: afterCancel ? 'PAYMENT_RECEIVED_AFTER_CANCEL' : null,
      });
      // The real statement writes the PAYMENT_CONFIRMED event in the same CTE.
      this.pushEvent(row.id, 'PAYMENT_CONFIRMED', { txHash: params[1], payerPublicKey: params[2] });
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE invoices SET status = 'CANCELLED'")) {
      const sellerPublicKey = params[1] ?? null;
      const row = this.rows.find(
        (candidate) =>
          candidate.id === params[0] &&
          candidate.status === 'PENDING' &&
          (!sellerPublicKey || candidate.seller_public_key === sellerPublicKey)
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'CANCELLED';
      row.cancelled_at = new Date();
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO payment_events')) {
      this.pushEvent(params[0], params[1], params[2] ? JSON.parse(params[2]) : null);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, invoice_id, event_type, event_data, created_at FROM payment_events')) {
      const found = this.events.filter((event) => event.invoice_id === params[0]);
      return { rows: found.map((event) => ({ ...event })), rowCount: found.length };
    }

    if (sql.startsWith('SELECT * FROM invoices WHERE id =')) {
      const found = this.rows.filter((row) => row.id === params[0]);
      return { rows: found.map((row) => ({ ...row })), rowCount: found.length };
    }

    throw new Error(`FakeInvoiceDb: unsupported SQL: ${sql.slice(0, 120)}`);
  }

  /** Force an invoice past its expiry without going through the sweep. */
  backdateExpiry(id: string, msAgo = 60_000): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no such invoice ${id}`);
    row.expires_at = new Date(Date.now() - msAgo);
  }

  private pushEvent(invoiceId: string, eventType: string, eventData: any): void {
    this.eventSeq += 1;
    this.events.push({
      id: `evt-${this.eventSeq}`,
      invoice_id: invoiceId,
      event_type: eventType,
      event_data: eventData,
      // Strictly increasing so ordering assertions do not depend on clock ticks.
      created_at: new Date(Date.now() + this.eventSeq),
    });
  }
}
