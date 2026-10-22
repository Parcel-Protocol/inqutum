import { format } from 'date-fns';
import {
  assertPaymentProofAvailable,
  canExportPaymentProof,
} from './payment-proof-policy.js';

import {
  PRINT_DOCUMENT_CSP,
  buildMailtoUrl,
  csvCell,
  escapeHtml,
} from './safe-content.js';

export { assertPaymentProofAvailable, canExportPaymentProof };
export { escapeHtml };

export interface Invoice {
  id: string;
  amount: number;
  assetCode: string;
  assetIssuer?: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
  sellerName?: string;
  sellerEmail?: string;
  payerName?: string;
  payerEmail?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  paidAt?: string;
  memo: string;
  sellerPublicKey: string;
  payerPublicKey?: string;
  paymentTxHash?: string;
}

/**
 * Export contract (issue #173).
 *
 * This module is the last hop before a user keeps a copy of invoice or payment
 * proof state, so its outcomes are explicit rather than incidental:
 *
 * - success: a browser action resolves to `{ ok: true, code }`;
 * - validation: the record cannot produce a truthful export
 *   (`INVALID_EXPORT_REQUEST`, `EXPORT_PROOF_UNAVAILABLE`,
 *   `INVALID_EXPORT_RECIPIENT`);
 * - retry: every failure carries `retryable`, `recoveryAction` and ordered
 *   `remediation` steps, so the UI can offer a next step instead of a dead end;
 * - degraded dependency: a missing or failing browser API (SSR, blocked pop-up,
 *   failed download) returns a failure and never throws or silently no-ops.
 *
 * Codes and metadata follow the conventions shared by the MVP path
 * (`lib/verification.js`, `lib/api-runtime.js`) and the persistent path
 * (`backend/src/errors/error-taxonomy.ts`): UPPER_SNAKE codes, a category,
 * `retryable`, `recoveryAction` and ordered `remediation` steps.
 */
export type ExportErrorCode =
  | 'INVALID_EXPORT_REQUEST'
  | 'EXPORT_PROOF_UNAVAILABLE'
  | 'INVALID_EXPORT_RECIPIENT'
  | 'EXPORT_POPUP_BLOCKED'
  | 'EXPORT_UNAVAILABLE'
  | 'EXPORT_FAILED';

/** Backend taxonomy categories an export failure can fall into. */
export type ExportErrorCategory = 'VALIDATION' | 'LIFECYCLE' | 'INTERNAL';

export interface ExportErrorDefinition {
  category: ExportErrorCategory;
  retryable: boolean;
  message: string;
  recoveryAction: string;
  remediation: string[];
}

/** Stable code metadata shared by thrown errors and returned failures. */
export const EXPORT_ERRORS: Record<ExportErrorCode, ExportErrorDefinition> = {
  INVALID_EXPORT_REQUEST: {
    category: 'VALIDATION',
    retryable: false,
    message: 'Invoice object is required to generate PDF',
    recoveryAction: 'Open the invoice again so a complete record is loaded, then retry the export.',
    remediation: [
      'Refresh the invoice so its id and status are loaded.',
      'Retry the export from the invoice view, or share the invoice link instead.',
    ],
  },
  EXPORT_PROOF_UNAVAILABLE: {
    category: 'LIFECYCLE',
    retryable: false,
    message: 'Payment proof is available only after the invoice is paid',
    recoveryAction:
      'Share the payment link while the invoice is unpaid; download the proof once it is PAID.',
    remediation: [
      'Refresh the invoice to confirm its current status.',
      'Share the payment link instead of a proof until the invoice is PAID.',
      'Ask the seller for a new invoice if this one expired unpaid.',
    ],
  },
  INVALID_EXPORT_RECIPIENT: {
    category: 'VALIDATION',
    retryable: false,
    message: 'Client email address is not valid',
    recoveryAction: 'Add a valid client email (name@domain.com) to the invoice, then retry the share.',
    remediation: [
      'Open the invoice and correct the client email.',
      'Retry the email share, or copy the invoice link instead.',
    ],
  },
  EXPORT_POPUP_BLOCKED: {
    category: 'INTERNAL',
    retryable: true,
    message: 'Pop-up blocked. Please allow pop-ups to print payment proof.',
    recoveryAction: 'Allow pop-ups for this site, then retry the download.',
    remediation: [
      'Check the browser address bar for a blocked pop-up notice.',
      'Allow pop-ups for this site and retry the download.',
      'If pop-ups stay blocked, share the invoice link or export the CSV instead.',
    ],
  },
  EXPORT_UNAVAILABLE: {
    category: 'INTERNAL',
    retryable: true,
    message: 'Export is only available in the browser.',
    recoveryAction: 'Open the invoice or dashboard in a browser tab, then retry the export.',
    remediation: [
      'Open the export from the invoice page or dashboard in a browser tab.',
      'Retry the export once the page is interactive.',
    ],
  },
  EXPORT_FAILED: {
    category: 'INTERNAL',
    retryable: true,
    message: 'Failed to generate payment proof PDF.',
    recoveryAction: 'Retry the export; if it keeps failing, reload the page.',
    remediation: [
      'Retry the export once.',
      'If it still fails, reload the page and retry.',
      'Share the invoice link instead if the proof cannot be generated.',
    ],
  },
};

/** Typed error for export helpers that keep a throwing contract. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly category: ExportErrorCategory;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly remediation: string[];

  constructor(
    code: ExportErrorCode,
    options: {
      message?: string;
      cause?: unknown;
      retryable?: boolean;
      recoveryAction?: string;
      remediation?: string[];
    } = {}
  ) {
    const definition = EXPORT_ERRORS[code];
    super(
      options.message || definition.message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = 'ExportError';
    this.code = code;
    this.category = definition.category;
    this.retryable = options.retryable === undefined ? definition.retryable : options.retryable;
    this.recoveryAction = options.recoveryAction || definition.recoveryAction;
    this.remediation = options.remediation || definition.remediation;
  }
}

/** Returned (never thrown) failure envelope for browser export actions. */
export interface ExportFailure {
  readonly ok: false;
  readonly code: ExportErrorCode;
  readonly message: string;
  readonly category: ExportErrorCategory;
  readonly retryable: boolean;
  readonly recoveryAction: string;
  readonly remediation: readonly string[];
}

export type ExportSuccessCode = 'EXPORT_OPENED' | 'EXPORT_DOWNLOADED' | 'EXPORT_SHARED';

export interface ExportSuccess {
  readonly ok: true;
  readonly code: ExportSuccessCode;
}

export type ExportResult = ExportSuccess | ExportFailure;

export function isExportError(error: unknown): error is ExportError {
  return error instanceof ExportError;
}

/** Normalises any thrown value into the shared failure envelope. */
export function toExportFailure(
  error: unknown,
  code: ExportErrorCode = 'EXPORT_FAILED',
  message?: string
): ExportFailure {
  if (isExportError(error)) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      recoveryAction: error.recoveryAction,
      remediation: error.remediation,
    };
  }

  const definition = EXPORT_ERRORS[code];
  return {
    ok: false,
    code,
    message: message || definition.message,
    category: definition.category,
    retryable: definition.retryable,
    recoveryAction: definition.recoveryAction,
    remediation: definition.remediation,
  };
}

function exportFailure(code: ExportErrorCode, message?: string): ExportFailure {
  return toExportFailure(null, code, message);
}

/** Requires the fields every export needs before it can describe an invoice. */
function requireExportInvoice(invoice: unknown, message?: string): Invoice {
  if (!invoice || typeof invoice !== 'object') {
    throw new ExportError('INVALID_EXPORT_REQUEST', { message });
  }
  const candidate = invoice as Partial<Invoice>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.trim() === '' ||
    typeof candidate.status !== 'string' ||
    candidate.status.trim() === ''
  ) {
    throw new ExportError('INVALID_EXPORT_REQUEST', {
      message: message || 'Invoice id and status are required to generate a payment proof',
    });
  }
  return invoice as Invoice;
}

/**
 * Safely formats a date without throwing RangeError on invalid date values.
 *
 * @param value Date input (string, number, Date)
 * @param formatPattern date-fns format string
 * @param fallback default string if date is invalid or missing
 */
export function safeFormatDate(
  value: unknown,
  formatPattern: string,
  fallback = ''
): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    const d = new Date(value as string | number | Date);
    if (!Number.isFinite(d.getTime())) {
      return fallback;
    }
    return format(d, formatPattern);
  } catch {
    return fallback;
  }
}

/**
 * Generates CSV content from an array of invoices with formula-injection protection
 * and resilient handling of missing or corrupted fields (issue #148).
 *
 * An empty list is a valid export (header row only), but a missing or non-array
 * list is a caller error: returning a header-only file for it would silently
 * misreport that every invoice had been exported (issue #173).
 */
export function generateInvoiceCSV(invoices: Invoice[]): string {
  const headers = [
    'Invoice ID',
    'Date',
    'Seller Name',
    'Seller Email',
    'Customer Name',
    'Customer Email',
    'Description',
    'Amount',
    'Asset',
    'Status',
    'Payment Date',
    'Payer Name',
    'Payer Email',
    'Expires At',
    'Memo',
    'Transaction Hash',
  ];

  if (!Array.isArray(invoices)) {
    throw new ExportError('INVALID_EXPORT_REQUEST', {
      message: 'Invoice list is required to export a CSV',
    });
  }

  if (invoices.length === 0) {
    return headers.join(',');
  }

  const rows = invoices
    .filter((inv) => inv && typeof inv === 'object')
    .map((inv) => [
      inv.id || '',
      safeFormatDate(inv.createdAt, 'yyyy-MM-dd HH:mm:ss', ''),
      inv.sellerName || '',
      inv.sellerEmail || '',
      inv.customerName || '',
      inv.customerEmail || '',
      inv.description || '',
      inv.amount !== null && inv.amount !== undefined ? inv.amount : '',
      inv.assetCode || '',
      inv.status || '',
      safeFormatDate(inv.paidAt, 'yyyy-MM-dd HH:mm:ss', ''),
      inv.payerName || '',
      inv.payerEmail || '',
      safeFormatDate(inv.expiresAt, 'yyyy-MM-dd HH:mm:ss', ''),
      inv.memo || '',
      inv.paymentTxHash || '',
    ]);

  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\n');

  return csvContent;
}

/**
 * Triggers a browser download of an invoice CSV file.
 *
 * Never throws: a missing browser API or a failing download returns a retryable
 * failure, and the object URL is revoked on every path.
 */
export function downloadInvoiceCSV(invoices: Invoice[], filename?: string): ExportResult {
  // Degraded dependency: without a browser there is nothing to click, but the
  // caller still gets a retryable failure instead of a silent no-op.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return exportFailure('EXPORT_UNAVAILABLE');
  }

  let url: string | null = null;
  let link: HTMLAnchorElement | null = null;

  try {
    const csv = generateInvoiceCSV(invoices);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    link = document.createElement('a');
    url = URL.createObjectURL(blob);

    const defaultFilename = `invoices-${safeFormatDate(new Date(), 'yyyy-MM-dd-HHmmss', 'export')}.csv`;
    link.setAttribute('href', url);
    link.setAttribute('download', filename || defaultFilename);
    link.style.visibility = 'hidden';

    document.body.appendChild(link);
    link.click();

    return { ok: true, code: 'EXPORT_DOWNLOADED' };
  } catch (error) {
    return toExportFailure(error, 'EXPORT_FAILED', 'Failed to generate CSV export.');
  } finally {
    try {
      link?.parentNode?.removeChild(link);
    } catch {
      // Detaching the temporary link is best-effort and never changes the result.
    }
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Generates standalone printable HTML for an invoice PDF.
 * Hardens boundary contracts for date tolerance, character escaping, and proof checks (issue #148).
 */
export function generateInvoicePDF(invoice: Invoice): string {
  requireExportInvoice(invoice);

  try {
    assertPaymentProofAvailable(invoice);
  } catch (error) {
    throw new ExportError('EXPORT_PROOF_UNAVAILABLE', {
      message: error instanceof Error ? error.message : undefined,
      cause: error,
    });
  }
  const network =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'TESTNET' ? 'Testnet' : 'Mainnet';
  const isPaid = invoice.status === 'PAID';

  const rawId = invoice.id || '';
  const displayId = rawId.substring(0, 8).toUpperCase();
  const createdDateStr = safeFormatDate(invoice.createdAt, 'MMM dd, yyyy', 'N/A');
  const expiresDateStr = safeFormatDate(invoice.expiresAt, 'MMM dd, yyyy', 'N/A');
  const paidDateStr = safeFormatDate(invoice.paidAt, 'MMM dd, yyyy HH:mm', 'N/A');
  const downloadedDateStr = safeFormatDate(new Date(), 'PPpp', new Date().toISOString());

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://quittance.app';
  const verifyUrl = `${origin}/pay/${encodeURIComponent(rawId)}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_DOCUMENT_CSP}">
  <title>Payment Proof - Invoice #${escapeHtml(invoice.id)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: Arial, sans-serif; 
      padding: 20px; 
      color: #1f2937; 
      background: white; 
      font-size: 14px;
      line-height: 1.4;
    }
    @media print {
      .no-print { display: none !important; }
    }
    .header { 
      display: flex; 
      justify-content: space-between; 
      margin-bottom: 30px; 
      padding-bottom: 15px; 
      border-bottom: 2px solid #0f766e; 
    }
    .logo { 
      font-size: 24px; 
      font-weight: bold; 
      color: #0f766e; 
    }
    .invoice-title { 
      text-align: right; 
    }
    .invoice-title h1 { 
      font-size: 28px; 
      color: #111827; 
      margin-bottom: 5px; 
    }
    .invoice-number { 
      color: #4b5563; 
      font-size: 12px; 
    }
    .status-badge { 
      display: inline-block; 
      padding: 4px 8px; 
      border-radius: 4px; 
      font-size: 10px; 
      font-weight: 600; 
      text-transform: uppercase; 
      margin-top: 8px; 
    }
    .status-paid { background: #d1fae5; color: #065f46; border: 2px solid #059669; }
    .status-pending { background: #fef3c7; color: #92400e; border: 2px solid #d97706; }
    .status-expired { background: #fee2e2; color: #991b1b; border: 2px solid #dc2626;}
    .info-grid { 
      display: flex; 
      gap: 20px; 
      margin-bottom: 30px; 
    }
    .info-section { 
      flex: 1;
      padding: 15px; 
      background: #f9fafb; 
      border-radius: 6px; 
    }
    .info-section h2 { 
      font-size: 12px; 
      color: #4b5563; 
      text-transform: uppercase; 
      margin-bottom: 10px; 
      letter-spacing: 0.5px; 
    }
    .info-row { 
      margin-bottom: 8px; 
    }
    .info-label { 
      font-size: 11px; 
      color: #4b5563; 
      margin-bottom: 2px; 
    }
    .info-value { 
      font-size: 12px; 
      color: #111827; 
      font-weight: 500; 
    }
    .amount-section { 
      background: #0e7490; 
      padding: 20px; 
      border-radius: 8px; 
      text-align: center; 
      margin-bottom: 20px; 
    }
    .amount-label { 
      color: white; 
      font-size: 12px; 
      margin-bottom: 8px; 
    }
    .amount-value { 
      font-size: 36px; 
      font-weight: bold; 
      color: white; 
      margin-bottom: 5px; 
    }
    .amount-asset { 
      color: white; 
      font-size: 16px; 
      font-weight: 600; 
    }
    .details-table { 
      width: 100%; 
      margin-bottom: 20px; 
      border-collapse: collapse;
    }
    .details-table tr { 
      border-bottom: 1px solid #e5e7eb; 
    }
    .details-table th, .details-table td { 
      padding: 8px 0; 
      text-align: left;
    }
    .details-table th { 
      color: #4b5563; 
      font-size: 11px; 
      font-weight: 600;
      width: 30%; 
    }
    .details-table td { 
      color: #111827; 
      font-size: 12px; 
      font-weight: 500; 
    }
    .footer { 
      margin-top: 30px; 
      padding-top: 15px; 
      border-top: 1px solid #e5e7eb; 
      text-align: center; 
      color: #4b5563; 
      font-size: 11px; 
    }
    .blockchain-info { 
      background: #fef3c7; 
      padding: 10px; 
      border-radius: 6px; 
      margin-bottom: 15px; 
      border-left: 3px solid #f59e0b; 
    }
    .blockchain-info p { 
      font-size: 11px; 
      color: #92400e; 
      line-height: 1.4; 
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">Quittance</div>
    <div class="invoice-title">
      <h1>INVOICE PROOF</h1>
      <div class="invoice-number">#${escapeHtml(displayId)}</div>
      <span class="status-badge status-${escapeHtml(invoice.status.toLowerCase())}" aria-label="Invoice Status: ${escapeHtml(invoice.status)}"> Status: ${escapeHtml(invoice.status)}</span>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-section">
      <h2>Bill To</h2>
      ${invoice.customerName ? `<div class="info-row"><div class="info-label">Customer Name</div><div class="info-value">${escapeHtml(invoice.customerName)}</div></div>` : ''}
      ${invoice.customerEmail ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value">${escapeHtml(invoice.customerEmail)}</div></div>` : ''}
      ${!invoice.customerName && !invoice.customerEmail ? `<div class="info-value">N/A</div>` : ''}
    </div>

    <div class="info-section">
      <h2>Invoice Details</h2>
      <div class="info-row">
        <div class="info-label">Issue Date</div>
        <div class="info-value">${escapeHtml(createdDateStr)}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Expires</div>
        <div class="info-value">${escapeHtml(expiresDateStr)}</div>
      </div>
      ${isPaid ? `<div class="info-row"><div class="info-label">Verified Payment Date</div><div class="info-value">${escapeHtml(paidDateStr)}</div></div>` : ''}
    </div>
  </div>

  ${invoice.sellerName || invoice.sellerEmail ? `
  <div class="info-section" style="margin-bottom: 20px;">
    <h2>Seller Information</h2>
    ${invoice.sellerName ? `<div class="info-row"><div class="info-label">Name</div><div class="info-value">${escapeHtml(invoice.sellerName)}</div></div>` : ''}
    ${invoice.sellerEmail ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value">${escapeHtml(invoice.sellerEmail)}</div></div>` : ''}
  </div>` : ''}

  ${isPaid && (invoice.payerName || invoice.payerEmail) ? `
  <div class="info-section" style="margin-bottom: 20px;">
    <h2>Payer Information</h2>
    ${invoice.payerName ? `<div class="info-row"><div class="info-label">Name</div><div class="info-value">${escapeHtml(invoice.payerName)}</div></div>` : ''}
    ${invoice.payerEmail ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value">${escapeHtml(invoice.payerEmail)}</div></div>` : ''}
  </div>` : ''}

  <div class="amount-section">
    <div class="amount-label">Amount ${isPaid ? 'Paid' : 'Due'}</div>
    <div class="amount-value">${escapeHtml(invoice.amount ?? '')}</div>
    <div class="amount-asset">${escapeHtml(invoice.assetCode || '')}</div>
  </div>

  ${invoice.description ? `<div class="info-section" style="margin-bottom: 20px;"><h2>Description</h2><p style="color: #1f2937; line-height: 1.6;">${escapeHtml(invoice.description)}</p></div>` : ''}

  <table class="details-table">
    <tr><th scope="row">Invoice ID</th><td style="font-family: monospace; font-size: 12px;">${escapeHtml(invoice.id)}</td></tr>
    <tr><th scope="row">Memo</th><td style="font-family: monospace;">${escapeHtml(invoice.memo)}</td></tr>
    <tr><th scope="row">Seller Address</th><td style="font-family: monospace; font-size: 11px; word-break: break-all;">${escapeHtml(invoice.sellerPublicKey)}</td></tr>
    ${isPaid && invoice.paymentTxHash ? `
    <tr><th scope="row">Verified Transaction Hash</th><td style="font-family: monospace; font-size: 11px; word-break: break-all;">${escapeHtml(invoice.paymentTxHash)}</td></tr>
    <tr><th scope="row">Payer Address</th><td style="font-family: monospace; font-size: 11px; word-break: break-all;">${escapeHtml(invoice.payerPublicKey || 'N/A')}</td></tr>
    ${invoice.payerName ? `<tr><th scope="row">Payer Name</th><td>${escapeHtml(invoice.payerName)}</td></tr>` : ''}
    ${invoice.payerEmail ? `<tr><th scope="row">Payer Email</th><td>${escapeHtml(invoice.payerEmail)}</td></tr>` : ''}` : ''}
    <tr><th scope="row">Network</th><td>${network}</td></tr>
  </table>

  ${isPaid ? `
  <div class="blockchain-info" role="region" aria-label="Payment Verification Status">
    <p><strong> [STATUS: PAID] Verified Settlement Record</strong></p>
    <p>This payment was verified against the Stellar ledger. Re-verify live status at any time:</p>
    <p style="margin-top: 4px; font-family: monospace; font-size: 11px; word-break: break-all;">
      <a href="${escapeHtml(verifyUrl)}" target="_blank" rel="noopener noreferrer" style="color: #0f766e; text-decoration: underline;">${escapeHtml(verifyUrl)}</a>
    </p>
  </div>` : ''}

  <div class="footer">
    <p><strong>Quittance</strong> - Stellar Payment Platform</p>
    <p>Verified At: ${escapeHtml(paidDateStr)} | Document Downloaded At: ${escapeHtml(downloadedDateStr)}</p>
    <p style="margin-top: 10px;">This is an automatically generated payment proof.</p>
  </div>

  <div class="no-print" style="position: fixed; top: 10px; right: 10px; background: #0f766e; color: white; padding: 15px; border-radius: 8px; z-index: 1000; max-width: 300px; font-family: Arial, sans-serif;">
    <h3 style="margin: 0 0 10px 0; font-size: 14px;">To Save as PDF or Print:</h3>
    <ol style="margin: 0; padding-left: 20px; font-size: 12px;">
      <li>Press Ctrl+P (Windows) or Cmd+P (Mac)</li>
      <li>Select "Destination" &rarr; "Save as PDF"</li>
      <li>Click "Save" or "Print"</li>
    </ol>
    <button type="button" onclick="window.print()" style="background: white; color: #0f766e; border: none; padding: 8px 16px; border-radius: 4px; margin-top: 10px; cursor: pointer; font-weight: bold; font-size: 12px;">
      Save as PDF / Print
    </button>
  </div>

</body>
</html>`;
}

/**
 * Opens the printable payment proof in a new window and triggers printing.
 *
 * Never throws: validation failures, a blocked pop-up and browser errors are
 * returned as typed results, so the caller can show the message and, when
 * `retryable` is true, offer a retry.
 */
export function openInvoicePDF(invoice: Invoice): ExportResult {
  // Degraded dependency: no DOM means no print window to open.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return exportFailure('EXPORT_UNAVAILABLE');
  }

  const triggerElement = document.activeElement as HTMLElement | null;
  const restoreFocus = () => {
    try {
      triggerElement?.focus();
    } catch {
      // Focus restoration is best-effort and must not mask the export result.
    }
  };

  let pdfContent: string;
  try {
    pdfContent = generateInvoicePDF(invoice);
  } catch (error) {
    return toExportFailure(error);
  }

  let printWindow: Window | null = null;
  try {
    printWindow = window.open('', '_blank', 'width=800,height=600');
  } catch (error) {
    restoreFocus();
    return toExportFailure(error);
  }

  if (!printWindow) {
    restoreFocus();
    return exportFailure('EXPORT_POPUP_BLOCKED');
  }

  try {
    printWindow.document.write(pdfContent);
    printWindow.document.close();

    printWindow.onload = () => {
      setTimeout(() => {
        try {
          printWindow?.print();
          if (printWindow) {
            printWindow.onafterprint = restoreFocus;
          }
        } catch {
          // A print dialog that cannot open leaves the proof readable; focus is
          // still restored below and no invoice state changes.
        }
        setTimeout(restoreFocus, 1000);
      }, 500);
    };
  } catch (error) {
    try {
      printWindow.close();
    } catch {
      // A pop-up that cannot be closed is still a failed export.
    }
    restoreFocus();
    return toExportFailure(error);
  }

  return { ok: true, code: 'EXPORT_OPENED' };
}

/**
 * Opens the system email client to share an invoice link or payment proof.
 *
 * Never throws and never writes invoice state: an unpaid invoice shares the
 * payment link, a paid invoice shares the verified payment facts. Validation
 * failures are returned with a stable code and recovery guidance so the caller
 * can keep offering the invoice link instead of dead-ending the user.
 */
export function shareInvoiceByEmail(invoice: Invoice): ExportResult {
  // Degraded dependency: no window means no mail client to hand off to.
  if (typeof window === 'undefined') {
    return exportFailure('EXPORT_UNAVAILABLE');
  }

  let record: Invoice;
  try {
    record = requireExportInvoice(invoice, 'Invoice object is required to send this invoice');
  } catch (error) {
    return toExportFailure(error);
  }

  const recipient = typeof record.customerEmail === 'string' ? record.customerEmail.trim() : '';
  if (!recipient) {
    return exportFailure(
      'INVALID_EXPORT_RECIPIENT',
      'Client email is required to send this invoice'
    );
  }

  const rawId = record.id || '';
  const displayId = rawId.substring(0, 8).toUpperCase();
  const subject = `Invoice #${displayId} - ${record.amount} ${record.assetCode}`;
  const isPaid = record.status === 'PAID';

  let body = `Invoice Details:\n`;
  body += `Invoice ID: ${rawId}\n`;
  body += `Amount: ${record.amount} ${record.assetCode}\n`;
  body += `Status: ${record.status}\n`;

  if (record.customerName) body += `Client: ${record.customerName}\n`;
  if (record.description) body += `Description: ${record.description}\n`;

  if (isPaid && record.paymentTxHash) {
    body += `\nPayment Information:\n`;
    body += `Payment Date: ${safeFormatDate(record.paidAt, 'PPpp', '')}\n`;
    body += `Transaction Hash: ${record.paymentTxHash}\n`;
    if (record.payerPublicKey) body += `Payer Address: ${record.payerPublicKey}\n`;
    body += `Verified on Stellar Blockchain\n`;
  } else {
    body += `\nQuittance: ${window.location.origin}/pay/${encodeURIComponent(rawId)}\n`;
  }

  body += `\nPowered by Quittance`;

  const mailtoLink = buildMailtoUrl(recipient, subject, body);
  if (!mailtoLink) {
    return exportFailure('INVALID_EXPORT_RECIPIENT');
  }

  try {
    window.location.href = mailtoLink;
  } catch (error) {
    return toExportFailure(error, 'EXPORT_FAILED', 'Could not open the email client.');
  }

  return { ok: true, code: 'EXPORT_SHARED' };
}
