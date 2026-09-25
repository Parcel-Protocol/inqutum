/**
 * Reconciliation (issue #45).
 *
 * Compares what the database says with what it can be checked against: its own
 * audit trail, the settlement references it holds for payments, and the balances
 * users are shown. It reports drift and says how to repair it. It never repairs
 * anything itself.
 *
 * The whole thing is one pure function over plain data. It performs no I/O and
 * has no way to mutate a store, so a dry run is safe wherever it runs: on a
 * laptop, in CI, or against a production read replica. Reading the data is the
 * caller's job (see `services/reconciliation.service.ts`), and that reading is
 * where read-only-ness is enforced.
 *
 * Findings fall into the four kinds the issue names:
 *
 *   missing       something that should exist does not
 *   duplicate     something that should be unique is not
 *   stale         something that should have moved on has not
 *   inconsistent  two records disagree
 */
import { INVOICE_STATUSES, isInvoiceStatus } from '../../../shared/invoice-lifecycle';
import { compareAmounts, formatStroops, parseStroops } from '../utils/safe-amount-compare';
import { assetsMatch, formatAssetIdentity, resolveInvoiceAsset, resolvePaymentAsset } from '../utils/asset-helpers';
import { hasInvoiceMemoPrefix } from '../utils/memo-prefix-check';

export type FindingCategory = 'missing' | 'duplicate' | 'stale' | 'inconsistent';
export type FindingSeverity = 'error' | 'warning';

export type FindingCode =
  // stale
  | 'PENDING_PAST_EXPIRY'
  // inconsistent
  | 'UNKNOWN_STATUS'
  | 'PAID_MISSING_PAYMENT_FIELDS'
  | 'UNPAID_HAS_PAYMENT_FIELDS'
  | 'CANCELLED_MISSING_TIMESTAMP'
  | 'SETTLEMENT_CONTEXT_MISMATCH'
  | 'AUDIT_TX_MISMATCH'
  | 'AUDIT_ORPHAN'
  | 'LEDGER_AMOUNT_MISMATCH'
  | 'LEDGER_ASSET_MISMATCH'
  | 'LEDGER_DESTINATION_MISMATCH'
  | 'LEDGER_MEMO_MISMATCH'
  | 'REVENUE_MISMATCH'
  // duplicate
  | 'DUPLICATE_INVOICE_ID'
  | 'DUPLICATE_MEMO'
  | 'DUPLICATE_PAYMENT_TX'
  | 'DUPLICATE_SETTLEMENT_RECORD'
  // missing
  | 'AUDIT_EVENT_MISSING'
  | 'PAID_WITHOUT_SETTLEMENT_RECORD'
  | 'SETTLEMENT_UNAPPLIED'
  | 'SETTLEMENT_UNKNOWN_INVOICE';

export interface ReconciliationInvoice {
  id: string;
  sellerPublicKey: string;
  amount: number | string;
  assetCode?: string;
  assetIssuer?: string;
  memo: string;
  status: string;
  paymentTxHash?: string | null;
  payerPublicKey?: string | null;
  paidAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  settledAt?: Date | string | null;
  settlementContext?: string | null;
  priorStatus?: string | null;
  expiresAt: Date | string;
}

export interface ReconciliationAuditEvent {
  invoiceId: string;
  eventType: string;
  eventData?: Record<string, unknown> | null;
}

/** A payment as recorded outside the invoice row: the `transactions` table or an exported ledger file. */
export interface ReconciliationSettlement {
  txHash: string;
  invoiceId?: string | null;
  destination?: string | null;
  amount: number | string;
  assetCode?: string | null;
  assetIssuer?: string | null;
  memo?: string | null;
}

/** Revenue as users are shown it (`revenue_by_asset` from the stats endpoint), per seller. */
export type ReportedRevenue = Record<string, Record<string, number | string>>;

export interface ReconciliationInput {
  invoices: ReconciliationInvoice[];
  /** null when the source keeps no audit trail: the audit checks are then skipped, not failed. */
  auditEvents: ReconciliationAuditEvent[] | null;
  /** null when no settlement references are available: ledger checks are then skipped. */
  settlements: ReconciliationSettlement[] | null;
  /** null when balances could not be read: the balance check is then skipped. */
  reportedRevenue: ReportedRevenue | null;
  now: Date;
  /**
   * A PENDING invoice is only "stale" once it is this far past expiry. The expiry
   * sweep runs on reads and on a timer, so being a few minutes behind is normal.
   */
  staleGraceMs?: number;
}

export interface Finding {
  code: FindingCode;
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  invoiceId?: string;
  txHash?: string;
  details?: Record<string, unknown>;
  /** What an operator should do. Guidance only: nothing here is applied automatically. */
  repair: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  /** Always true. The report is read-only by construction; there is no apply mode. */
  dryRun: true;
  checked: {
    invoices: number;
    auditEvents: number | null;
    settlements: number | null;
    revenueSellers: number | null;
  };
  /** Which checks ran; a skipped check means "could not verify", not "verified clean". */
  checksRun: {
    invoiceIntegrity: true;
    audit: boolean;
    ledger: boolean;
    balances: boolean;
  };
  summary: {
    total: number;
    byCategory: Record<FindingCategory, number>;
    bySeverity: Record<FindingSeverity, number>;
  };
  findings: Finding[];
  /** True when there are no findings at all. */
  clean: boolean;
}

export const DEFAULT_STALE_GRACE_MS = 5 * 60 * 1000;

const CATEGORIES: FindingCategory[] = ['missing', 'duplicate', 'stale', 'inconsistent'];

const REPAIR = {
  PENDING_PAST_EXPIRY:
    'The expiry sweep has not run. Call markExpiredInvoices (it runs on every read and every 60s while the payment monitor is up); if it keeps recurring, check that the monitor and the database clock are healthy.',
  UNKNOWN_STATUS:
    'Do not edit blindly. Find how a value outside PENDING/PAID/EXPIRED/CANCELLED got in (a manual UPDATE, a partial migration) and restore the last valid state from the audit trail.',
  PAID_MISSING_PAYMENT_FIELDS:
    'Look the invoice up in payment_events and on Horizon for the payment that settled it, then restore payment_tx_hash, payer_public_key and paid_at from that evidence. If no payment exists, the PAID status is wrong.',
  UNPAID_HAS_PAYMENT_FIELDS:
    'A payment reference sits on an invoice that is not PAID. Confirm on Horizon whether the payment is real: if it is, settle the invoice through the normal verify path; if not, clear the stray fields.',
  CANCELLED_MISSING_TIMESTAMP:
    'Without cancelled_at a later payment cannot be classified as before or after the cancel. Recover the time from the INVOICE_CANCELLED audit event and set cancelled_at.',
  SETTLEMENT_CONTEXT_MISMATCH:
    'Recompute settlement_context from settled_at and cancelled_at (settled_at >= cancelled_at is AFTER_CANCEL) and correct the row.',
  AUDIT_TX_MISMATCH:
    'The audit trail and the invoice name different transactions. Treat the on-chain transaction as the source of truth: check Horizon, then correct whichever record is wrong.',
  AUDIT_ORPHAN:
    'An audit event points at an invoice that does not exist. Usually an invoice was deleted out-of-band; confirm before removing the event.',
  LEDGER_AMOUNT_MISMATCH:
    'The recorded settlement and the invoice disagree on the amount. Check Horizon for the real amount; an underpayment marked PAID needs manual follow-up with the seller.',
  LEDGER_ASSET_MISMATCH:
    'The recorded settlement is in a different asset than the invoice. Check Horizon; the invoice may have been settled with the wrong asset.',
  LEDGER_DESTINATION_MISMATCH:
    'The recorded settlement went to a different account than the invoice seller. Check Horizon; funds may have reached the wrong wallet.',
  LEDGER_MEMO_MISMATCH:
    'The recorded settlement carries a different memo than the invoice. Check Horizon for which invoice the payment belongs to.',
  REVENUE_MISMATCH:
    'The balance shown to the seller differs from the sum of their PAID invoices. Recompute from the invoices (they are the source of truth) and find why the stats path diverged.',
  DUPLICATE_INVOICE_ID:
    'Two rows share an invoice id, which the primary key should prevent. Investigate how the constraint was bypassed before touching data.',
  DUPLICATE_MEMO:
    'Two invoices share a memo, so a payment can no longer be attributed to one of them. Keep the one that was actually paid; the other must be cancelled or given a new memo.',
  DUPLICATE_PAYMENT_TX:
    'One on-chain payment is recorded against more than one invoice, so revenue is overstated. Keep it on the invoice whose memo matches the transaction and revert the others.',
  DUPLICATE_SETTLEMENT_RECORD:
    'The same transaction appears more than once in the settlement records. De-duplicate the export; a database table with a unique tx_hash cannot produce this.',
  AUDIT_EVENT_MISSING:
    'The state change has no audit event. Rows that predate the audit trail (issue #43) are expected to show this; for newer rows, find why the event was not written and backfill it from the invoice timestamps.',
  PAID_WITHOUT_SETTLEMENT_RECORD:
    'No settlement reference is on file for this payment. Payments verified through the API are not always mirrored into the transactions table; confirm the transaction on Horizon and, if genuine, backfill the record.',
  SETTLEMENT_UNAPPLIED:
    'Funds were received (a settlement is on file) but the invoice was never marked PAID. This is the drift to fix first: verify the payment through the normal verify path so the invoice is settled through the lifecycle.',
  SETTLEMENT_UNKNOWN_INVOICE:
    'A payment carries an invoice memo that matches no invoice. Check whether the invoice was deleted, or the payment was misdirected, and arrange a refund if needed.',
} as const satisfies Record<FindingCode, string>;

interface Context {
  now: number;
  graceMs: number;
  findings: Finding[];
}

function add(
  context: Context,
  code: FindingCode,
  category: FindingCategory,
  severity: FindingSeverity,
  message: string,
  extra: Pick<Finding, 'invoiceId' | 'txHash' | 'details'> = {}
): void {
  context.findings.push({ code, category, severity, message, ...extra, repair: REPAIR[code] });
}

const time = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** An invoice amount as a 7-decimal string, without float formatting surprises. */
const amountText = (value: number | string): string =>
  typeof value === 'number' ? value.toFixed(7) : String(value);

const stroops = (value: number | string): bigint | null => parseStroops(amountText(value));

function groupBy<T>(items: T[], key: (item: T) => string | null | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function checkInvoiceIntegrity(invoices: ReconciliationInvoice[], context: Context): void {
  for (const [id, group] of groupBy(invoices, (i) => i.id)) {
    if (group.length > 1) {
      add(context, 'DUPLICATE_INVOICE_ID', 'duplicate', 'error', `Invoice id ${id} appears ${group.length} times`, {
        invoiceId: id,
        details: { count: group.length },
      });
    }
  }

  for (const [memo, group] of groupBy(invoices, (i) => i.memo)) {
    if (group.length > 1) {
      add(context, 'DUPLICATE_MEMO', 'duplicate', 'error', `Memo ${memo} is shared by ${group.length} invoices`, {
        details: { memo, invoiceIds: group.map((i) => i.id) },
      });
    }
  }

  for (const [txHash, group] of groupBy(invoices, (i) => i.paymentTxHash)) {
    const distinct = [...new Set(group.map((i) => i.id))];
    if (distinct.length > 1) {
      add(
        context,
        'DUPLICATE_PAYMENT_TX',
        'duplicate',
        'error',
        `Transaction ${txHash} is recorded against ${distinct.length} invoices`,
        { txHash, details: { invoiceIds: distinct } }
      );
    }
  }

  for (const invoice of invoices) {
    const { id } = invoice;

    if (!isInvoiceStatus(invoice.status)) {
      add(context, 'UNKNOWN_STATUS', 'inconsistent', 'error', `Invoice has unknown status "${invoice.status}"`, {
        invoiceId: id,
        details: { status: invoice.status, expected: [...INVOICE_STATUSES] },
      });
      continue;
    }

    if (invoice.status === 'PAID') {
      const missing = [
        !invoice.paymentTxHash && 'paymentTxHash',
        !invoice.payerPublicKey && 'payerPublicKey',
        !invoice.paidAt && 'paidAt',
      ].filter(Boolean);
      if (missing.length > 0) {
        add(context, 'PAID_MISSING_PAYMENT_FIELDS', 'inconsistent', 'error', `PAID invoice is missing ${missing.join(', ')}`, {
          invoiceId: id,
          details: { missing },
        });
      }
    } else if (invoice.paymentTxHash || invoice.paidAt) {
      add(
        context,
        'UNPAID_HAS_PAYMENT_FIELDS',
        'inconsistent',
        'error',
        `${invoice.status} invoice carries payment data`,
        {
          invoiceId: id,
          txHash: invoice.paymentTxHash ?? undefined,
          details: { status: invoice.status, paymentTxHash: invoice.paymentTxHash ?? null, paidAt: invoice.paidAt ?? null },
        }
      );
    }

    if (invoice.status === 'CANCELLED' && time(invoice.cancelledAt) === null) {
      add(context, 'CANCELLED_MISSING_TIMESTAMP', 'inconsistent', 'error', 'CANCELLED invoice has no cancelled_at', {
        invoiceId: id,
      });
    }

    const cancelledAt = time(invoice.cancelledAt);
    const settledAt = time(invoice.settledAt);
    if (
      invoice.status === 'PAID' &&
      invoice.priorStatus === 'CANCELLED' &&
      cancelledAt !== null &&
      settledAt !== null &&
      invoice.settlementContext
    ) {
      const expected = settledAt >= cancelledAt ? 'AFTER_CANCEL' : 'ON_TIME';
      if (invoice.settlementContext !== expected) {
        add(
          context,
          'SETTLEMENT_CONTEXT_MISMATCH',
          'inconsistent',
          'error',
          `Settlement context is ${invoice.settlementContext} but the timestamps say ${expected}`,
          { invoiceId: id, details: { recorded: invoice.settlementContext, expected } }
        );
      }
    }

    const expiresAt = time(invoice.expiresAt);
    if (invoice.status === 'PENDING' && expiresAt !== null && expiresAt <= context.now - context.graceMs) {
      add(
        context,
        'PENDING_PAST_EXPIRY',
        'stale',
        'warning',
        `PENDING invoice expired ${Math.round((context.now - expiresAt) / 60000)} minutes ago and was never marked EXPIRED`,
        { invoiceId: id, details: { expiresAt: new Date(expiresAt).toISOString() } }
      );
    }
  }
}

/** Audit event each terminal-ish state should have left behind. */
const EXPECTED_AUDIT: Record<string, string> = {
  PAID: 'PAYMENT_CONFIRMED',
  CANCELLED: 'INVOICE_CANCELLED',
  EXPIRED: 'INVOICE_EXPIRED',
};

function checkAudit(
  invoices: ReconciliationInvoice[],
  events: ReconciliationAuditEvent[],
  context: Context
): void {
  const byInvoice = groupBy(events, (e) => e.invoiceId);
  const known = new Set(invoices.map((i) => i.id));

  for (const [invoiceId, group] of byInvoice) {
    if (!known.has(invoiceId)) {
      add(context, 'AUDIT_ORPHAN', 'inconsistent', 'warning', `${group.length} audit event(s) reference an unknown invoice`, {
        invoiceId,
        details: { eventTypes: group.map((e) => e.eventType) },
      });
    }
  }

  for (const invoice of invoices) {
    const expected = EXPECTED_AUDIT[invoice.status];
    if (!expected) continue;
    const own = byInvoice.get(invoice.id) ?? [];
    const match = own.filter((e) => e.eventType === expected);

    if (match.length === 0) {
      add(
        context,
        'AUDIT_EVENT_MISSING',
        'missing',
        'warning',
        `${invoice.status} invoice has no ${expected} audit event`,
        { invoiceId: invoice.id, details: { expectedEvent: expected } }
      );
      continue;
    }

    if (invoice.status === 'PAID' && invoice.paymentTxHash) {
      const confirmed = match
        .map((e) => e.eventData?.txHash)
        .filter((hash): hash is string => typeof hash === 'string');
      if (confirmed.length > 0 && !confirmed.includes(invoice.paymentTxHash)) {
        add(context, 'AUDIT_TX_MISMATCH', 'inconsistent', 'error', 'Audit trail and invoice name different transactions', {
          invoiceId: invoice.id,
          txHash: invoice.paymentTxHash,
          details: { invoiceTx: invoice.paymentTxHash, auditTx: confirmed },
        });
      }
    }
  }
}

function checkLedger(
  invoices: ReconciliationInvoice[],
  settlements: ReconciliationSettlement[],
  context: Context
): void {
  for (const [txHash, group] of groupBy(settlements, (s) => s.txHash)) {
    if (group.length > 1) {
      add(context, 'DUPLICATE_SETTLEMENT_RECORD', 'duplicate', 'error', `Transaction ${txHash} appears ${group.length} times in the settlement records`, {
        txHash,
        details: { count: group.length },
      });
    }
  }

  const settlementByTx = new Map<string, ReconciliationSettlement>();
  for (const settlement of settlements) {
    if (!settlementByTx.has(settlement.txHash)) settlementByTx.set(settlement.txHash, settlement);
  }
  const invoiceByMemo = new Map(invoices.map((i) => [i.memo, i]));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  for (const invoice of invoices) {
    if (invoice.status !== 'PAID' || !invoice.paymentTxHash) continue;

    const settlement = settlementByTx.get(invoice.paymentTxHash);
    if (!settlement) {
      add(
        context,
        'PAID_WITHOUT_SETTLEMENT_RECORD',
        'missing',
        'warning',
        'PAID invoice has no matching settlement record',
        { invoiceId: invoice.id, txHash: invoice.paymentTxHash }
      );
      continue;
    }

    const expectedStroops = stroops(invoice.amount);
    const actualStroops = parseStroops(amountText(settlement.amount));
    if (!compareAmounts(amountText(invoice.amount), amountText(settlement.amount))) {
      add(
        context,
        'LEDGER_AMOUNT_MISMATCH',
        'inconsistent',
        'error',
        `Invoice amount ${amountText(invoice.amount)} but settlement recorded ${amountText(settlement.amount)}`,
        {
          invoiceId: invoice.id,
          txHash: invoice.paymentTxHash,
          details: {
            invoiceAmount: amountText(invoice.amount),
            settlementAmount: amountText(settlement.amount),
            differenceStroops:
              expectedStroops !== null && actualStroops !== null ? String(actualStroops - expectedStroops) : null,
          },
        }
      );
    }

    const invoiceAsset = resolveInvoiceAsset({ assetCode: invoice.assetCode, assetIssuer: invoice.assetIssuer });
    const settledAsset = resolvePaymentAsset({
      assetType: settlement.assetIssuer || (settlement.assetCode && settlement.assetCode !== 'XLM') ? 'credit' : 'native',
      assetCode: settlement.assetCode ?? undefined,
      assetIssuer: settlement.assetIssuer ?? undefined,
    });
    if (!assetsMatch(invoiceAsset, settledAsset)) {
      add(
        context,
        'LEDGER_ASSET_MISMATCH',
        'inconsistent',
        'error',
        `Invoice is in ${formatAssetIdentity(invoiceAsset)} but the settlement is in ${formatAssetIdentity(settledAsset)}`,
        { invoiceId: invoice.id, txHash: invoice.paymentTxHash }
      );
    }

    if (settlement.destination && settlement.destination !== invoice.sellerPublicKey) {
      add(context, 'LEDGER_DESTINATION_MISMATCH', 'inconsistent', 'error', 'Settlement went to a different account than the invoice seller', {
        invoiceId: invoice.id,
        txHash: invoice.paymentTxHash,
        details: { seller: invoice.sellerPublicKey, destination: settlement.destination },
      });
    }

    if (settlement.memo && settlement.memo !== invoice.memo) {
      add(context, 'LEDGER_MEMO_MISMATCH', 'inconsistent', 'error', 'Settlement memo differs from the invoice memo', {
        invoiceId: invoice.id,
        txHash: invoice.paymentTxHash,
        details: { invoiceMemo: invoice.memo, settlementMemo: settlement.memo },
      });
    }
  }

  // The other direction: money on file that the invoices do not reflect.
  const appliedTx = new Set(invoices.filter((i) => i.status === 'PAID').map((i) => i.paymentTxHash));
  for (const settlement of settlementByTx.values()) {
    const target =
      (settlement.invoiceId && invoiceById.get(settlement.invoiceId)) ||
      (settlement.memo ? invoiceByMemo.get(settlement.memo) : undefined);

    if (!target) {
      if (hasInvoiceMemoPrefix(settlement.memo)) {
        add(context, 'SETTLEMENT_UNKNOWN_INVOICE', 'missing', 'warning', 'Settlement carries an invoice memo that matches no invoice', {
          txHash: settlement.txHash,
          details: { memo: settlement.memo },
        });
      }
      continue;
    }

    if (target.status !== 'PAID' && !appliedTx.has(settlement.txHash)) {
      add(
        context,
        'SETTLEMENT_UNAPPLIED',
        'missing',
        'error',
        `A settlement is on file but the invoice is ${target.status}, not PAID`,
        {
          invoiceId: target.id,
          txHash: settlement.txHash,
          details: { status: target.status, amount: amountText(settlement.amount) },
        }
      );
    }
  }
}

function checkBalances(
  invoices: ReconciliationInvoice[],
  reported: ReportedRevenue,
  context: Context
): void {
  const derived = new Map<string, Map<string, bigint>>();
  for (const invoice of invoices) {
    if (invoice.status !== 'PAID') continue;
    const value = stroops(invoice.amount);
    if (value === null) continue;
    const asset = invoice.assetCode || 'XLM';
    const perAsset = derived.get(invoice.sellerPublicKey) ?? new Map<string, bigint>();
    perAsset.set(asset, (perAsset.get(asset) ?? 0n) + value);
    derived.set(invoice.sellerPublicKey, perAsset);
  }

  const sellers = new Set([...derived.keys(), ...Object.keys(reported)]);
  for (const seller of [...sellers].sort()) {
    const expectedByAsset = derived.get(seller) ?? new Map<string, bigint>();
    const shown = reported[seller] ?? {};
    const assets = new Set([...expectedByAsset.keys(), ...Object.keys(shown)]);

    for (const asset of [...assets].sort()) {
      const expected = expectedByAsset.get(asset) ?? 0n;
      const raw = shown[asset];
      const actual = raw === undefined ? 0n : parseStroops(amountText(raw as number | string));
      if (actual === null || actual !== expected) {
        add(
          context,
          'REVENUE_MISMATCH',
          'inconsistent',
          'error',
          `Seller ${seller} sees ${raw === undefined ? '0' : String(raw)} ${asset} but PAID invoices sum to ${formatStroops(expected)}`,
          {
            details: {
              seller,
              asset,
              shown: raw ?? null,
              derived: formatStroops(expected),
            },
          }
        );
      }
    }
  }
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1 };

export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const context: Context = {
    now: input.now.getTime(),
    graceMs: input.staleGraceMs ?? DEFAULT_STALE_GRACE_MS,
    findings: [],
  };

  checkInvoiceIntegrity(input.invoices, context);
  if (input.auditEvents) checkAudit(input.invoices, input.auditEvents, context);
  if (input.settlements) checkLedger(input.invoices, input.settlements, context);
  if (input.reportedRevenue) checkBalances(input.invoices, input.reportedRevenue, context);

  // Deterministic order, so two runs over the same data produce the same report:
  // errors first, then by kind, then by the thing they are about.
  const findings = context.findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
      a.code.localeCompare(b.code) ||
      (a.invoiceId ?? a.txHash ?? '').localeCompare(b.invoiceId ?? b.txHash ?? '')
  );

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<FindingCategory, number>;
  const bySeverity: Record<FindingSeverity, number> = { error: 0, warning: 0 };
  for (const finding of findings) {
    byCategory[finding.category] += 1;
    bySeverity[finding.severity] += 1;
  }

  return {
    generatedAt: input.now.toISOString(),
    dryRun: true,
    checked: {
      invoices: input.invoices.length,
      auditEvents: input.auditEvents ? input.auditEvents.length : null,
      settlements: input.settlements ? input.settlements.length : null,
      revenueSellers: input.reportedRevenue ? Object.keys(input.reportedRevenue).length : null,
    },
    checksRun: {
      invoiceIntegrity: true,
      audit: input.auditEvents !== null,
      ledger: input.settlements !== null,
      balances: input.reportedRevenue !== null,
    },
    summary: { total: findings.length, byCategory, bySeverity },
    findings,
    clean: findings.length === 0,
  };
}
