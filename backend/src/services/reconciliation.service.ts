import { reconcile } from '../domain/reconciliation';
import type {
  ReconciliationReport,
  ReconciliationSettlement,
  ReportedRevenue,
} from '../domain/reconciliation';
import type { InvoiceStorage } from '../storage/invoice-storage';

export interface RunReconciliationOptions {
  now?: Date;
  staleGraceMs?: number;
  /**
   * Settlement references to check against, replacing whatever the storage
   * holds. Use this to reconcile against an exported ledger file. `undefined`
   * means "ask the storage"; `null` means "skip the ledger checks".
   */
  settlements?: ReconciliationSettlement[] | null;
}

/**
 * Reads everything reconciliation needs through the storage's read-only methods
 * and hands it to the pure `reconcile`. No method called here writes, so this is
 * safe to run against any environment, including production.
 *
 * The balance check asks the storage for each seller's stats once, so it costs
 * one small aggregate query per seller. That is fine for an on-demand or
 * scheduled dry run; it is not something to put on a hot path.
 */
export async function runReconciliation(
  storage: InvoiceStorage,
  options: RunReconciliationOptions = {}
): Promise<ReconciliationReport> {
  const invoices = await storage.listInvoicesForReconciliation();
  const auditEvents = await storage.listAuditEvents();
  const settlements =
    options.settlements !== undefined ? options.settlements : await storage.listSettlements();

  const reportedRevenue: ReportedRevenue = {};
  for (const seller of new Set(invoices.map((invoice) => invoice.sellerPublicKey))) {
    const [stats] = await storage.readInvoiceStats(seller);
    reportedRevenue[seller] = stats?.revenue_by_asset ?? {};
  }

  return reconcile({
    invoices,
    auditEvents: auditEvents.map((event) => ({
      invoiceId: event.invoiceId,
      eventType: event.eventType,
      eventData: event.eventData,
    })),
    settlements,
    reportedRevenue,
    now: options.now ?? new Date(),
    staleGraceMs: options.staleGraceMs,
  });
}
