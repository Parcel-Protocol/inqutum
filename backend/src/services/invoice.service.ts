import { v4 as uuidv4 } from 'uuid';
import { pool } from '../config/database';
import { generateInvoiceMemo } from '../utils/memo';
import { CreateInvoiceInput } from '../utils/validation';
import type { InvoiceStats } from '../storage/invoice-stats';
import { calculateInvoiceExpiry } from '../domain/invoice-expiry';
import {
  SettlementTimeUnavailableError,
  type LatePaymentWarningCode,
  type SettlementContext,
} from '../domain/invoice-settlement';
import {
  InvalidTransitionError,
  assertTransition,
  type InvoiceEvent,
  type InvoiceStatus,
} from '../../../shared/invoice-lifecycle';
import { PaymentClaimError } from '../domain/payment-attribution';
import type { AuditEvent, MarkAsPaidOptions } from '../storage/invoice-storage';
import type { ReconciliationInvoice, ReconciliationSettlement } from '../domain/reconciliation';

// PostgreSQL invoice service. Kept behaviourally identical to
// InvoiceMemoryService so callers that go through the shared InvoiceStorage
// interface cannot tell which backend is running. Invariants mirrored on both
// sides: (1) normal markAsPaid succeeds when status is PENDING AND expires_at
// is strictly after now(), while an exact cancelled-invoice payment may settle
// with cancellation context, (2) cancelInvoice only succeeds when status is
// PENDING, (3) every read path calls markExpiredInvoices first so expired rows
// transition before being reported, (4) list + stats are scoped to the caller's
// seller_public_key, (5) credit assets always carry their asset_issuer because
// createInvoiceSchema already rejected anything less.
/** Minimal database surface used by this service (pg Pool or a test double). */
export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface Invoice {
  id: string;
  sellerPublicKey: string;
  sellerName?: string;
  sellerEmail?: string;
  amount: number;
  assetCode: string;
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
  priorStatus?: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  latePaymentWarningCode?: LatePaymentWarningCode;
  expiresAt: Date;
  metadata?: any;
}

export class InvoiceService {
  constructor(private readonly db: Queryable = pool) {}

  /**
   * Create a new invoice for the seller wallet supplied by the request
   */
  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    if (!input.sellerPublicKey) {
      throw new Error('Seller public key is required');
    }

    const id = uuidv4();
    const memo = generateInvoiceMemo();
    const expiresAt = calculateInvoiceExpiry(input.expiresInDays);

    const query = `
      INSERT INTO invoices (
        id, seller_public_key, seller_name, seller_email, amount,
        asset_code, asset_issuer, memo, description, customer_name,
        customer_email, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;

    const values = [
      id,
      input.sellerPublicKey,
      input.sellerName || null,
      input.sellerEmail || null,
      input.amount,
      (input.assetCode || 'XLM').toUpperCase(),
      input.assetIssuer || null,
      memo,
      input.description || null,
      input.customerName || null,
      input.customerEmail || null,
      'PENDING',
      expiresAt,
    ];

    try {
      const result = await this.db.query(query, values);
      console.log('✅ Invoice created:', result.rows[0].id);
      await this.recordLifecycleEvent(result.rows[0].id, 'INVOICE_CREATED', { to: 'PENDING' });
      return this.mapRowToInvoice(result.rows[0]);
    } catch (error: any) {
      console.error('Error creating invoice:', error);
      throw new Error(`Failed to create invoice: ${error.message}`);
    }
  }

  /**
   * Get invoice by ID
   */
  async getInvoiceById(id: string): Promise<Invoice | null> {
    await this.markExpiredInvoices();
    const query = 'SELECT * FROM invoices WHERE id = $1';
    const result = await this.db.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToInvoice(result.rows[0]);
  }

  /**
   * Get invoice by memo
   */
  async getInvoiceByMemo(memo: string): Promise<Invoice | null> {
    await this.markExpiredInvoices();
    const query = 'SELECT * FROM invoices WHERE memo = $1';
    const result = await this.db.query(query, [memo]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToInvoice(result.rows[0]);
  }

  /**
   * Update invoice status to PAID
   */
  async markAsPaid(
    invoiceId: string,
    txHash: string,
    payerPublicKey: string,
    payerInfo?: { payerName?: string; payerEmail?: string },
    options?: MarkAsPaidOptions
  ): Promise<Invoice> {
    const settledAt = options?.settledAt ?? null;
    const query = `
      WITH settled AS (
        UPDATE invoices
        SET status = 'PAID',
            payment_tx_hash = $2,
            payer_public_key = $3,
            paid_at = NOW(),
            payer_name = $4,
            payer_email = $5,
            settled_at = COALESCE($6::timestamptz, NOW()),
            settlement_context = CASE
              WHEN status = 'CANCELLED' AND $6::timestamptz >= cancelled_at THEN 'AFTER_CANCEL'
              ELSE 'ON_TIME'
            END,
            prior_status = CASE
              WHEN status = 'CANCELLED' THEN status
              ELSE NULL
            END,
            late_payment_warning_code = CASE
              WHEN status = 'CANCELLED' AND $6::timestamptz >= cancelled_at THEN 'PAYMENT_RECEIVED_AFTER_CANCEL'
              ELSE NULL
            END
        WHERE id = $1
          AND (
            (status = 'PENDING' AND expires_at > NOW())
            OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND $6::timestamptz IS NOT NULL)
          )
        RETURNING *
      ),
      payment_event AS (
        INSERT INTO payment_events (invoice_id, event_type, event_data)
        SELECT
          id,
          'PAYMENT_CONFIRMED',
          jsonb_strip_nulls(jsonb_build_object(
            'txHash', $2::text,
            'payerPublicKey', $3::text,
            'settledAt', settled_at,
            'settlementContext', settlement_context,
            'priorStatus', prior_status,
            'latePaymentWarningCode', late_payment_warning_code
          ))
        FROM settled
        RETURNING id
      )
      SELECT * FROM settled
    `;

    try {
      const result = await this.db.query(query, [
        invoiceId,
        txHash,
        payerPublicKey,
        payerInfo?.payerName || null,
        payerInfo?.payerEmail || null,
        settledAt,
      ]);

      if (result.rows.length === 0) {
        const existing = await this.db.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
        const row = existing.rows[0];
        if (!row) {
          throw new Error('Invoice not found');
        }
        if (row.status === 'CANCELLED' && !settledAt) {
          throw new SettlementTimeUnavailableError();
        }
        // The guarded UPDATE matched nothing, so the invoice is not in a state
        // that can settle. Ask the lifecycle why, so the refusal is the same
        // one the memory store gives. A PENDING row that reached this point
        // has crossed its expiry, which the sweep had not yet recorded.
        const pastExpiry = row.status === 'PENDING' && new Date(row.expires_at).getTime() <= Date.now();
        const current: string = pastExpiry ? 'EXPIRED' : row.status;
        const event: InvoiceEvent = current === 'CANCELLED' ? 'SETTLE_AFTER_CANCEL' : 'SETTLE';
        assertTransition(current, event);
        // Unreachable when the lifecycle and the UPDATE's WHERE clause agree;
        // reaching it means they drifted, which must not pass silently.
        throw new InvalidTransitionError(current, 'PAID', event);
      }

      console.log('✅ Invoice marked as paid:', invoiceId);

      return this.mapRowToInvoice(result.rows[0]);
    } catch (error: any) {
      // 23505 = unique_violation on idx_invoices_payment_tx_hash_unique: this
      // transaction already settled another invoice. The database is the
      // durable backstop for the in-process PaymentClaimIndex (issue #14).
      if (error?.code === '23505' && String(error?.constraint ?? '').includes('payment_tx_hash')) {
        const settled = await this.db
          .query('SELECT id FROM invoices WHERE payment_tx_hash = $1', [txHash])
          .catch(() => ({ rows: [] as any[] }));
        throw new PaymentClaimError(txHash, invoiceId, settled.rows[0]?.id ?? 'unknown');
      }
      if (
        error instanceof SettlementTimeUnavailableError ||
        error instanceof InvalidTransitionError ||
        error?.message === 'Invoice not found'
      ) {
        throw error;
      }
      console.error('Error marking invoice as paid:', error);
      throw new Error(`Failed to update invoice: ${error.message}`);
    }
  }

  /**
   * Get all invoices for a seller
   */
  async getInvoicesBySeller(
    sellerPublicKey: string,
    status?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<Invoice[]> {
    if (!sellerPublicKey) {
      throw new Error('Seller public key is required');
    }

    await this.markExpiredInvoices();

    let query = 'SELECT * FROM invoices WHERE seller_public_key = $1';
    const params: any[] = [sellerPublicKey];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await this.db.query(query, params);
    return result.rows.map((row) => this.mapRowToInvoice(row));
  }

  /**
   * Cancel an invoice
   */
  async cancelInvoice(invoiceId: string, sellerPublicKey?: string): Promise<Invoice> {
    await this.markExpiredInvoices();

    const query = `
      UPDATE invoices 
      SET status = 'CANCELLED', cancelled_at = NOW()
      WHERE id = $1 AND status = 'PENDING' AND ($2::text IS NULL OR seller_public_key = $2)
      RETURNING *
    `;

    const result = await this.db.query(query, [invoiceId, sellerPublicKey || null]);

    if (result.rows.length === 0) {
      const existing = await this.db.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
      const row = existing.rows[0];
      if (!row) {
        throw new Error('Invoice not found');
      }
      if (sellerPublicKey && row.seller_public_key !== sellerPublicKey) {
        throw new Error('Unauthorized: only the seller can cancel this invoice');
      }
      // Same refusal the memory store gives for a cancel the lifecycle forbids.
      assertTransition(row.status, 'CANCEL');
      throw new InvalidTransitionError(row.status, 'CANCELLED', 'CANCEL');
    }

    await this.recordLifecycleEvent(invoiceId, 'INVOICE_CANCELLED', {
      from: 'PENDING',
      to: 'CANCELLED',
      actor: sellerPublicKey,
    });
    return this.mapRowToInvoice(result.rows[0]);
  }

  /**
   * Mark expired invoices
   */
  async markExpiredInvoices(now: Date = new Date()): Promise<number> {
    const query = `
      UPDATE invoices 
      SET status = 'EXPIRED'
      WHERE status = 'PENDING' AND expires_at <= $1
      RETURNING id
    `;

    const result = await this.db.query(query, [now]);
    console.log(`⏰ Marked ${result.rowCount} invoices as expired`);
    for (const row of result.rows) {
      await this.recordLifecycleEvent(row.id, 'INVOICE_EXPIRED', { from: 'PENDING', to: 'EXPIRED' });
    }
    return result.rowCount || 0;
  }

  /**
   * Log payment event
   */
  async logPaymentEvent(invoiceId: string, eventType: string, eventData: any): Promise<void> {
    const query = `
      INSERT INTO payment_events (invoice_id, event_type, event_data)
      VALUES ($1, $2, $3)
    `;

    await this.db.query(query, [invoiceId, eventType, JSON.stringify(eventData)]);
  }

  /**
   * Record a state change in the audit trail. The status write has already
   * committed by the time this runs, so a failure here is logged rather than
   * thrown: failing the request would tell the caller a committed transition
   * did not happen, which is worse than a missing audit row.
   */
  private async recordLifecycleEvent(
    invoiceId: string,
    eventType: string,
    eventData: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.logPaymentEvent(invoiceId, eventType, eventData);
    } catch (error: any) {
      console.error(`Failed to record ${eventType} audit event for ${invoiceId}:`, error?.message || error);
    }
  }

  /**
   * Every invoice as stored, for reconciliation. Read-only: no expiry sweep, and
   * amounts stay as the exact decimal strings Postgres returns rather than being
   * rounded through a float.
   */
  async listInvoicesForReconciliation(): Promise<ReconciliationInvoice[]> {
    const result = await this.db.query('SELECT * FROM invoices ORDER BY created_at ASC, id ASC');
    return result.rows.map((row) => ({
      id: row.id,
      sellerPublicKey: row.seller_public_key,
      amount: String(row.amount),
      assetCode: row.asset_code ?? undefined,
      assetIssuer: row.asset_issuer ?? undefined,
      memo: row.memo,
      status: row.status,
      paymentTxHash: row.payment_tx_hash,
      payerPublicKey: row.payer_public_key,
      paidAt: row.paid_at,
      cancelledAt: row.cancelled_at,
      settledAt: row.settled_at,
      settlementContext: row.settlement_context,
      priorStatus: row.prior_status,
      expiresAt: row.expires_at,
    }));
  }

  /** Every audit event, oldest first. Read-only. */
  async listAuditEvents(): Promise<AuditEvent[]> {
    const result = await this.db.query(
      `SELECT id, invoice_id, event_type, event_data, created_at
       FROM payment_events
       ORDER BY created_at ASC, id ASC`
    );
    return result.rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      eventType: row.event_type,
      eventData: row.event_data ?? null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Payments the monitor recorded in `transactions`, as settlement references.
   * Read-only. Not every settled invoice has one (the verify endpoint does not
   * write here), which is why a missing row is reported as a warning.
   */
  async listSettlements(): Promise<ReconciliationSettlement[]> {
    const result = await this.db.query(
      `SELECT tx_hash, invoice_id, to_address, amount, asset_code, asset_issuer, memo
       FROM transactions
       ORDER BY processed_at ASC, tx_hash ASC`
    );
    return result.rows.map((row) => ({
      txHash: row.tx_hash,
      invoiceId: row.invoice_id,
      destination: row.to_address,
      amount: String(row.amount),
      assetCode: row.asset_code,
      assetIssuer: row.asset_issuer,
      memo: row.memo,
    }));
  }

  /**
   * Audit trail for one invoice, oldest first.
   */
  async getAuditTrail(invoiceId: string): Promise<AuditEvent[]> {
    const result = await this.db.query(
      `SELECT id, invoice_id, event_type, event_data, created_at
       FROM payment_events
       WHERE invoice_id = $1
       ORDER BY created_at ASC, id ASC`,
      [invoiceId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      eventType: row.event_type,
      eventData: row.event_data ?? null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get invoice statistics
   */
  async getInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]> {
    if (!sellerPublicKey) {
      throw new Error('Seller public key is required');
    }

    await this.markExpiredInvoices();
    return this.readInvoiceStats(sellerPublicKey);
  }

  /**
   * Statistics without the expiry sweep, so reading them never writes.
   */
  async readInvoiceStats(sellerPublicKey: string): Promise<InvoiceStats[]> {
    if (!sellerPublicKey) {
      throw new Error('Seller public key is required');
    }

    const query = `
      SELECT 
        COUNT(*) as total_invoices,
        COALESCE(SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END), 0) as paid_invoices,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending_invoices,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as actionable_invoices,
        COALESCE(SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END), 0) as expired_invoices,
        COALESCE(
          (
            SELECT jsonb_object_agg(asset_code, total_revenue)
            FROM (
              SELECT COALESCE(asset_code, 'XLM') as asset_code, SUM(amount) as total_revenue
              FROM invoices
              WHERE seller_public_key = $1 AND status = 'PAID'
              GROUP BY COALESCE(asset_code, 'XLM')
            ) paid_revenue
          ),
          '{}'::jsonb
        ) as revenue_by_asset
      FROM invoices
      WHERE seller_public_key = $1
    `;

    const result = await this.db.query(query, [sellerPublicKey]);
    return result.rows.map((row) => this.mapRowToStats(row));
  }

  /**
   * Get total invoice count (for ceiling enforcement)
   */
  async getInvoiceCount(): Promise<number> {
    const query = 'SELECT COUNT(*) as count FROM invoices';
    const result = await this.db.query(query);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Map an aggregate row to stats. Postgres returns COUNT/SUM as strings, so the
   * numbers are normalised to match the in-memory backend.
   */
  private mapRowToStats(row: any): InvoiceStats {
    const revenueByAsset: Record<string, number> = {};

    Object.entries(row.revenue_by_asset || {}).forEach(([assetCode, revenue]) => {
      revenueByAsset[assetCode] = Number(revenue);
    });

    return {
      total_invoices: Number(row.total_invoices),
      paid_invoices: Number(row.paid_invoices),
      pending_invoices: Number(row.pending_invoices),
      actionable_invoices: Number(row.actionable_invoices ?? row.pending_invoices),
      expired_invoices: Number(row.expired_invoices),
      revenue_by_asset: revenueByAsset,
    };
  }

  /**
   * Map database row to Invoice object
   */
  private mapRowToInvoice(row: any): Invoice {
    return {
      id: row.id,
      sellerPublicKey: row.seller_public_key,
      sellerName: row.seller_name,
      sellerEmail: row.seller_email,
      amount: parseFloat(row.amount),
      assetCode: row.asset_code,
      assetIssuer: row.asset_issuer,
      memo: row.memo,
      description: row.description,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      status: row.status,
      paymentTxHash: row.payment_tx_hash,
      payerPublicKey: row.payer_public_key,
      payerName: row.payer_name,
      payerEmail: row.payer_email,
      createdAt: row.created_at,
      paidAt: row.paid_at,
      cancelledAt: row.cancelled_at,
      settledAt: row.settled_at,
      settlementContext: row.settlement_context,
      priorStatus: row.prior_status,
      latePaymentWarningCode: row.late_payment_warning_code,
      expiresAt: row.expires_at,
      metadata: row.metadata,
    };
  }

  async countInvoices(): Promise<number> {
    const res = await this.db.query('SELECT COUNT(*) as count FROM invoices');
    return parseInt(res.rows[0]?.count || '0', 10);
  }

  async purgeStaleInvoices(options: { maxAgeHours: number; statuses?: any[] }): Promise<number> {
    const cutoff = new Date(Date.now() - options.maxAgeHours * 3600 * 1000);
    const res = await this.db.query(
      `DELETE FROM invoices
       WHERE created_at <= $1
         AND (status IN ('PAID', 'EXPIRED', 'CANCELLED') OR (status = 'PENDING' AND expires_at <= NOW()))`,
      [cutoff]
    );
    return res.rowCount || 0;
  }
}

export default new InvoiceService();
