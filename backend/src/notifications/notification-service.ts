/**
 * Notifications for critical invoice lifecycle and recovery events (issue #56).
 *
 * Design:
 *  - Recipients are wallet public keys, the same identity every invoice route
 *    already scopes by. A notification is only ever readable by its recipient.
 *  - Notifications carry only non-sensitive facts (invoice id, amount, asset,
 *    memo, status). Customer/payer names and emails are never copied in.
 *  - Every notification has a deterministic dedup key. Emitting the same
 *    logical event again (request retry, repeated reads, worker replay) is a
 *    no-op, so a critical event notifies exactly once.
 *  - Emission is derived from invoice state (`syncInvoiceNotifications`), so it
 *    also catches transitions that happen inside storage, such as expiry.
 */

import { v4 as uuidv4 } from 'uuid';
import type { StoredInvoice } from '../storage/invoice-storage';
import type { VerificationCode } from '../services/payment-verification';

export type NotificationType =
  | 'invoice.paid'
  | 'invoice.expired'
  | 'invoice.cancelled'
  | 'payment.rejected';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface Notification {
  id: string;
  recipient: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  /** App-relative path to the workflow that needs attention. */
  deepLink: string;
  dedupKey: string;
  entityId: string;
  data: Record<string, string | number>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationQuery {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationPage {
  notifications: Notification[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
}

/** Verification failures the seller can act on (recovery path), not payer typos. */
export const RECOVERABLE_REJECTIONS: ReadonlySet<VerificationCode> = new Set<VerificationCode>([
  'AMOUNT_MISMATCH',
  'ASSET_MISMATCH',
  'MEMO_MISMATCH',
  'DESTINATION_MISMATCH',
  'NETWORK_MISMATCH',
  'NO_PAYMENT_OPERATION',
]);

const REJECTION_ADVICE: Partial<Record<VerificationCode, string>> = {
  AMOUNT_MISMATCH: 'A payment was submitted with the wrong amount. Ask the payer to send the remaining or corrected amount, or cancel and reissue the invoice.',
  ASSET_MISMATCH: 'A payment was submitted in a different asset than invoiced. Ask the payer to pay in the invoiced asset.',
  MEMO_MISMATCH: 'A payment referenced this invoice but the memo did not match. Ask the payer to resend with the invoice memo.',
  DESTINATION_MISMATCH: 'A payment referenced this invoice but was sent to a different account.',
  NETWORK_MISMATCH: 'A payment was submitted on a different Stellar network than this invoice uses.',
  NO_PAYMENT_OPERATION: 'A transaction referenced this invoice but contained no payment operation.',
};

const MAX_PAGE = 100;

export class MemoryNotificationStore {
  private byId = new Map<string, Notification>();
  private byDedup = new Map<string, string>();
  private byRecipient = new Map<string, string[]>();

  /** Returns the existing notification (created=false) if the dedup key was already used. */
  insert(n: Notification): { notification: Notification; created: boolean } {
    const existingId = this.byDedup.get(n.dedupKey);
    if (existingId) return { notification: this.byId.get(existingId)!, created: false };
    this.byId.set(n.id, n);
    this.byDedup.set(n.dedupKey, n.id);
    const ids = this.byRecipient.get(n.recipient) ?? [];
    ids.push(n.id);
    this.byRecipient.set(n.recipient, ids);
    return { notification: n, created: true };
  }

  listForRecipient(recipient: string): Notification[] {
    return (this.byRecipient.get(recipient) ?? []).map((id) => this.byId.get(id)!).reverse();
  }

  getForRecipient(recipient: string, id: string): Notification | undefined {
    const n = this.byId.get(id);
    return n && n.recipient === recipient ? n : undefined;
  }

  clear(): void {
    this.byId.clear();
    this.byDedup.clear();
    this.byRecipient.clear();
  }
}

export class NotificationService {
  constructor(
    private readonly store = new MemoryNotificationStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  private emit(
    input: Pick<Notification, 'recipient' | 'type' | 'severity' | 'title' | 'message' | 'entityId' | 'data'> & { dedupKey: string }
  ): { notification: Notification; created: boolean } {
    return this.store.insert({
      id: uuidv4(),
      ...input,
      deepLink: `/invoice/${encodeURIComponent(input.entityId)}`,
      createdAt: this.now().toISOString(),
      readAt: null,
    });
  }

  /**
   * Emits the notification implied by the invoice's current status, if any.
   * Safe to call on every read or retry: each event is created at most once.
   */
  syncInvoiceNotifications(invoice: StoredInvoice): Notification | null {
    const facts = {
      invoiceId: invoice.id,
      amount: invoice.amount,
      assetCode: invoice.assetCode,
      memo: invoice.memo,
    };
    const label = `${invoice.amount} ${invoice.assetCode}`;
    const base = { recipient: invoice.sellerPublicKey, entityId: invoice.id, data: facts };

    switch (invoice.status) {
      case 'PAID':
        return this.emit({ ...base, type: 'invoice.paid', severity: 'success', dedupKey: `${invoice.id}:invoice.paid`, title: 'Invoice paid', message: `Payment of ${label} was verified for invoice ${invoice.memo}.` }).notification;
      case 'EXPIRED':
        return this.emit({ ...base, type: 'invoice.expired', severity: 'warning', dedupKey: `${invoice.id}:invoice.expired`, title: 'Invoice expired', message: `Invoice ${invoice.memo} (${label}) expired unpaid. Create a new invoice to collect payment.` }).notification;
      case 'CANCELLED':
        return this.emit({ ...base, type: 'invoice.cancelled', severity: 'info', dedupKey: `${invoice.id}:invoice.cancelled`, title: 'Invoice cancelled', message: `Invoice ${invoice.memo} (${label}) was cancelled.` }).notification;
      default:
        return null;
    }
  }

  /** Recovery notification for a payment attempt the seller may need to resolve. */
  notifyPaymentRejected(invoice: StoredInvoice, code: VerificationCode, txHash: string): Notification | null {
    if (!RECOVERABLE_REJECTIONS.has(code)) return null;
    return this.emit({
      recipient: invoice.sellerPublicKey,
      entityId: invoice.id,
      type: 'payment.rejected',
      severity: 'critical',
      dedupKey: `${invoice.id}:payment.rejected:${txHash}:${code}`,
      title: 'Payment needs attention',
      message: REJECTION_ADVICE[code] ?? 'A payment attempt for this invoice was rejected.',
      data: { invoiceId: invoice.id, memo: invoice.memo, code, txHash },
    }).notification;
  }

  list(recipient: string, query: NotificationQuery = {}): NotificationPage {
    const all = this.store.listForRecipient(recipient);
    const filtered = query.unreadOnly ? all.filter((n) => !n.readAt) : all;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(query.offset ?? 0, 0);
    return {
      notifications: filtered.slice(offset, offset + limit),
      total: filtered.length,
      unread: all.filter((n) => !n.readAt).length,
      limit,
      offset,
    };
  }

  unreadCount(recipient: string): number {
    return this.store.listForRecipient(recipient).filter((n) => !n.readAt).length;
  }

  /** Returns null for unknown ids AND for other recipients' ids, so existence never leaks. */
  markRead(recipient: string, id: string): Notification | null {
    const n = this.store.getForRecipient(recipient, id);
    if (!n) return null;
    if (!n.readAt) n.readAt = this.now().toISOString();
    return n;
  }

  markAllRead(recipient: string): number {
    let changed = 0;
    for (const n of this.store.listForRecipient(recipient)) {
      if (!n.readAt) {
        n.readAt = this.now().toISOString();
        changed += 1;
      }
    }
    return changed;
  }

  clear(): void {
    this.store.clear();
  }
}

export const notificationService = new NotificationService();
