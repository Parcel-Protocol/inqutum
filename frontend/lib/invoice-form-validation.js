const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field order matches the form, so the first key is the first invalid field. */
const FIELD_ORDER = ['amount', 'sellerEmail', 'customerEmail'];

/**
 * Per-field errors for the create-invoice form. Rendered inline and wired to
 * inputs through aria-describedby, so screen readers announce them.
 *
 * @param {{ amount: string, sellerEmail: string, customerEmail: string }} values
 * @returns {Partial<Record<'amount' | 'sellerEmail' | 'customerEmail', string>>}
 */
const validateInvoiceForm = ({ amount, sellerEmail, customerEmail }) => {
  const errors = {};
  if (!amount || !(parseFloat(amount) > 0)) errors.amount = 'Enter an amount greater than 0.';
  if (sellerEmail.trim() && !EMAIL_PATTERN.test(sellerEmail.trim())) {
    errors.sellerEmail = 'Enter a valid email address, like you@example.com.';
  }
  if (customerEmail.trim() && !EMAIL_PATTERN.test(customerEmail.trim())) {
    errors.customerEmail = 'Enter a valid client email address, like client@example.com.';
  }
  return errors;
};

/** @param {Record<string, string>} errors */
const firstInvalidField = (errors) => FIELD_ORDER.find((field) => errors[field]) || null;

module.exports = { validateInvoiceForm, firstInvalidField };
