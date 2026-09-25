/**
 * Client-side fail-closed projection of the server expiry lifecycle.
 *
 * What a status allows comes from shared/invoice-lifecycle.ts, the same table
 * the backend stores enforce, so the UI cannot offer an action the server would
 * refuse. Only the clock is projected here: a PENDING invoice past its
 * expiresAt reads as EXPIRED before the server's sweep has recorded it.
 */

const {
  INVOICE_STATUSES,
  allowedTransitions,
  canTransition,
  isTerminalStatus,
  nextStatus,
} = require('../../shared/invoice-lifecycle.ts');

function expiryTimestamp(expiresAt) {
  if (!expiresAt) return null;
  const timestamp = new Date(expiresAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasInvoiceExpired(invoice, now = Date.now()) {
  if (!invoice) return false;
  if (invoice.status === 'EXPIRED') return true;
  if (invoice.status !== 'PENDING') return false;

  const expiresAt = expiryTimestamp(invoice.expiresAt);
  return expiresAt !== null && expiresAt <= new Date(now).getTime();
}

function effectiveInvoiceStatus(invoice, now = Date.now()) {
  return hasInvoiceExpired(invoice, now) ? 'EXPIRED' : invoice?.status;
}

function applyExpiryStatus(invoice, now = Date.now()) {
  if (!invoice || effectiveInvoiceStatus(invoice, now) === invoice.status) return invoice;
  return { ...invoice, status: 'EXPIRED' };
}

function applyExpiryLifecycle(invoices, now = Date.now()) {
  if (!Array.isArray(invoices)) return [];
  return invoices.map((invoice) => applyExpiryStatus(invoice, now));
}

function isActionableInvoice(invoice, now = Date.now()) {
  return canPayInvoice(invoice, now);
}

/**
 * Whether the seller may cancel the invoice right now. Asks the lifecycle for
 * the CANCEL event rather than hard-coding "is PENDING", and honours expiry.
 */
function canCancelInvoice(invoice, now = Date.now()) {
  if (!invoice) return false;
  return nextStatus(effectiveInvoiceStatus(invoice, now), 'CANCEL') !== null;
}

/**
 * Whether a payer may still settle the invoice on time. This is the SETTLE
 * event, not "any transition to PAID": a cancelled invoice can be settled late
 * by the server when a payment is found, but the UI must never invite one.
 */
function canPayInvoice(invoice, now = Date.now()) {
  if (!invoice || invoice.paymentTxHash) return false;
  return nextStatus(effectiveInvoiceStatus(invoice, now), 'SETTLE') !== null;
}

module.exports = {
  INVOICE_STATUSES,
  allowedTransitions,
  canTransition,
  isTerminalStatus,
  canCancelInvoice,
  canPayInvoice,
  expiryTimestamp,
  hasInvoiceExpired,
  effectiveInvoiceStatus,
  applyExpiryStatus,
  applyExpiryLifecycle,
  isActionableInvoice,
};
