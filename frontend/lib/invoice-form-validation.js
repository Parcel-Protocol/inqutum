/**
 * Invoice creation form validation contract (issues #259, #149).
 * Hardens boundary contracts for amount limits, decimal precision, email sanity,
 * and error ordering.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field order matches the form, so the first key is the first invalid field. */
const FIELD_ORDER = ['amount', 'sellerEmail', 'customerEmail'];

const InvoiceFormCode = Object.freeze({
  OK: 'OK',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  API_UNREACHABLE: 'API_UNREACHABLE',
  API_REQUEST_FAILED: 'API_REQUEST_FAILED',
});

const AMOUNT_REQUIRED_MESSAGE = 'Enter an amount greater than 0.';
const AMOUNT_LIMIT_MESSAGE = 'Amount exceeds maximum allowed limit.';
const SELLER_EMAIL_MESSAGE = 'Enter a valid email address, like you@example.com.';
const CUSTOMER_EMAIL_MESSAGE = 'Enter a valid client email address, like client@example.com.';
const UNREACHABLE_MESSAGE = 'Quittance API is unreachable. Check your connection and try again.';

const INVOICE_FORM_RECOVERY = Object.freeze({
  [InvoiceFormCode.VALIDATION_FAILED]:
    'Review the highlighted fields, correct any invalid formats, and submit again.',
  [InvoiceFormCode.API_UNREACHABLE]:
    'Check your connection and submit the invoice again. Nothing was saved.',
  [InvoiceFormCode.API_REQUEST_FAILED]:
    'Retry the invoice only when the failure is marked retryable.',
});

const readOptionalText = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value) {
    return '';
  }
  return String(value).trim();
};

const readAmount = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const isDegradedDependency = (dependency) => {
  if (dependency == null || dependency === false) {
    return false;
  }
  if (typeof dependency === 'string') {
    const normalized = dependency.trim().toLowerCase();
    return normalized === 'degraded' || normalized === 'unavailable' || normalized === 'unreachable';
  }
  if (typeof dependency !== 'object') {
    return false;
  }
  if (dependency.degraded === true || dependency.available === false) {
    return true;
  }
  if (dependency.name === 'ApiUnavailableError') {
    return true;
  }
  if (dependency.code === InvoiceFormCode.API_UNREACHABLE) {
    return true;
  }
  return typeof dependency.status === 'string' && dependency.status.trim().toLowerCase() === 'degraded';
};

/** Maximum acceptable invoice amount (1 trillion units). */
const MAX_INVOICE_AMOUNT = 1e12;

/** Maximum allowable decimals (Stellar base token precision). */
const MAX_DECIMAL_PLACES = 7;

/** Maximum RFC 5321 email address length. */
const MAX_EMAIL_LENGTH = 254;

const amountPrecisionMessage = () =>
  `Amount cannot have more than ${MAX_DECIMAL_PLACES} decimal places.`;

const invalidEmail = (email, message) => {
  if (!email) {
    return null;
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return message;
  }
  return null;
};

/**
 * Validates invoice form input fields with hardened edge-case checks.
 *
 * @param {{ amount?: string | number, sellerEmail?: string, customerEmail?: string }} values
 * @returns {Partial<Record<'amount' | 'sellerEmail' | 'customerEmail', string>>}
 */
const validateInvoiceForm = (values) => {
  const errors = {};

  if (!values || typeof values !== 'object') {
    errors.amount = AMOUNT_REQUIRED_MESSAGE;
    return errors;
  }

  const rawAmount = readAmount(values.amount);

  if (!rawAmount || !/^\d+(\.\d+)?$/.test(rawAmount)) {
    errors.amount = AMOUNT_REQUIRED_MESSAGE;
  } else {
    const parsed = parseFloat(rawAmount);
    if (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
      errors.amount = AMOUNT_REQUIRED_MESSAGE;
    } else if (rawAmount.includes('.') && rawAmount.split('.')[1].length > MAX_DECIMAL_PLACES) {
      errors.amount = amountPrecisionMessage();
    } else if (parsed > MAX_INVOICE_AMOUNT) {
      errors.amount = AMOUNT_LIMIT_MESSAGE;
    }
  }

  const sellerEmailError = invalidEmail(readOptionalText(values.sellerEmail), SELLER_EMAIL_MESSAGE);
  if (sellerEmailError) {
    errors.sellerEmail = sellerEmailError;
  }

  const customerEmailError = invalidEmail(
    readOptionalText(values.customerEmail),
    CUSTOMER_EMAIL_MESSAGE
  );
  if (customerEmailError) {
    errors.customerEmail = customerEmailError;
  }

  return errors;
};

/**
 * Returns the first invalid field identifier according to standard form focus order.
 *
 * @param {Record<string, string> | null | undefined} errors
 * @returns {string | null}
 */
const firstInvalidField = (errors) => {
  if (!errors || typeof errors !== 'object') {
    return null;
  }
  return FIELD_ORDER.find((field) => Boolean(errors[field])) || null;
};

const validationFailure = (errors) => {
  const firstInvalid = firstInvalidField(errors);
  return {
    ok: false,
    code: InvoiceFormCode.VALIDATION_FAILED,
    retryable: false,
    degraded: false,
    errors,
    firstInvalid,
    message: errors[firstInvalid] || AMOUNT_REQUIRED_MESSAGE,
    recoveryAction: INVOICE_FORM_RECOVERY[InvoiceFormCode.VALIDATION_FAILED],
  };
};

const degradedFailure = () => ({
  ok: false,
  code: InvoiceFormCode.API_UNREACHABLE,
  retryable: true,
  degraded: true,
  errors: {},
  firstInvalid: null,
  message: UNREACHABLE_MESSAGE,
  recoveryAction: INVOICE_FORM_RECOVERY[InvoiceFormCode.API_UNREACHABLE],
});

const resolveInvoiceFormOutcome = (values, dependency) => {
  const errors = validateInvoiceForm(values);
  if (firstInvalidField(errors)) {
    return validationFailure(errors);
  }
  if (isDegradedDependency(dependency)) {
    return degradedFailure();
  }

  return {
    ok: true,
    code: InvoiceFormCode.OK,
    retryable: false,
    degraded: false,
    amount: readAmount(values.amount),
    sellerEmail: readOptionalText(values.sellerEmail),
    customerEmail: readOptionalText(values.customerEmail),
  };
};

const classifyInvoiceFormFailure = (error, fallbackMessage = 'Failed to create invoice') => {
  const degraded =
    error?.code === InvoiceFormCode.API_UNREACHABLE || error?.name === 'ApiUnavailableError';
  const retryable = degraded || error?.retryable === true;
  const code =
    typeof error?.code === 'string' && error.code.trim()
      ? error.code.trim()
      : degraded
        ? InvoiceFormCode.API_UNREACHABLE
        : InvoiceFormCode.API_REQUEST_FAILED;
  const message =
    typeof error?.message === 'string' && error.message.trim()
      ? error.message.trim()
      : fallbackMessage;

  return {
    code,
    message,
    retryable,
    degraded,
    recoveryAction: INVOICE_FORM_RECOVERY[code] || INVOICE_FORM_RECOVERY[InvoiceFormCode.API_REQUEST_FAILED],
  };
};

module.exports = {
  validateInvoiceForm,
  firstInvalidField,
  resolveInvoiceFormOutcome,
  classifyInvoiceFormFailure,
  InvoiceFormCode,
  INVOICE_FORM_RECOVERY,
  MAX_INVOICE_AMOUNT,
  MAX_DECIMAL_PLACES,
  MAX_EMAIL_LENGTH,
};
