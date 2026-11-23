export type InvoiceFormField = 'amount' | 'sellerEmail' | 'customerEmail';
export type InvoiceFormErrors = Partial<Record<InvoiceFormField, string>>;

export function validateInvoiceForm(values: {
  amount: string;
  sellerEmail: string;
  customerEmail: string;
}): InvoiceFormErrors;

export function firstInvalidField(errors: InvoiceFormErrors): InvoiceFormField | null;

export const InvoiceFormCode: {
  readonly OK: 'OK';
  readonly VALIDATION_FAILED: 'VALIDATION_FAILED';
  readonly API_UNREACHABLE: 'API_UNREACHABLE';
  readonly API_REQUEST_FAILED: 'API_REQUEST_FAILED';
};

export const INVOICE_FORM_RECOVERY: {
  readonly VALIDATION_FAILED: string;
  readonly API_UNREACHABLE: string;
  readonly API_REQUEST_FAILED: string;
};

export const MAX_INVOICE_AMOUNT: number;
export const MAX_DECIMAL_PLACES: number;
export const MAX_EMAIL_LENGTH: number;

export interface InvoiceFormSuccess {
  ok: true;
  code: 'OK';
  retryable: false;
  degraded: false;
  amount: string;
  sellerEmail: string;
  customerEmail: string;
}

export interface InvoiceFormFailure {
  ok: false;
  code: 'VALIDATION_FAILED' | 'API_UNREACHABLE';
  retryable: boolean;
  degraded: boolean;
  errors: InvoiceFormErrors;
  firstInvalid: InvoiceFormField | null;
  message: string;
  recoveryAction: string;
}

export type InvoiceFormOutcome = InvoiceFormSuccess | InvoiceFormFailure;

export interface InvoiceFormFailureClassification {
  code: string;
  message: string;
  retryable: boolean;
  degraded: boolean;
  recoveryAction: string;
}

export function resolveInvoiceFormOutcome(
  values: {
    amount?: string | number;
    sellerEmail?: string;
    customerEmail?: string;
  } | null | undefined,
  dependency?: unknown
): InvoiceFormOutcome;

export function classifyInvoiceFormFailure(
  error: unknown,
  fallbackMessage?: string
): InvoiceFormFailureClassification;
