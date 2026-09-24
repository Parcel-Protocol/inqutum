/**
 * Client mirror of the canonical verification contract (issues #224, #5, #11, #13).
 *
 * The authority is `backend/src/services/payment-verification.ts`; this file
 * exists so the pay flow can reject malformed input before a round trip and
 * surface the exact code/message the server would return. Keep the codes and
 * messages here identical to the backend module.
 */

const VERIFICATION_MESSAGES = {
  MISSING_TX_HASH: 'Transaction hash is required',
  INVALID_TX_HASH: 'Transaction hash must be 64 hexadecimal characters',
  INVALID_PAYER_NAME: 'Payer name must be text',
  INVALID_PAYER_EMAIL: 'Payer email is invalid',
  PAYER_INFO_TOO_LONG: 'Payer information is too long',
  INVOICE_ALREADY_PAID: 'Invoice has already been paid',
  INVOICE_EXPIRED: 'Invoice has expired and can no longer accept payment',
  INVOICE_NOT_PENDING: 'Invoice is not pending',
  TRANSACTION_NOT_FOUND: 'Transaction not found on Stellar',
  NO_PAYMENT_OPERATION: 'No payment operation found in transaction',
  MEMO_MISMATCH: 'Memo mismatch',
  DESTINATION_MISMATCH: 'Payment destination mismatch',
  AMOUNT_MISMATCH: 'Amount mismatch',
  ASSET_MISMATCH: 'Asset mismatch',
  NETWORK_MISMATCH: 'Transaction is on a different Stellar network',
  TX_HASH_ALREADY_USED: 'Transaction hash has already been used for another invoice',
};

const STROOP_PRECISION = 7;
const NATIVE_ASSET_CODE = 'XLM';
const MAX_PAYER_FIELD_LENGTH = 255;
const PAYER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const normalizeTransactionHash = (value) =>
  typeof value === 'string' ? value.trim() : '';

const failure = (code) => ({
  ok: false,
  code,
  error: VERIFICATION_MESSAGES[code],
});

/** A Stellar transaction hash is 64 hexadecimal characters. */
const isValidTxHash = (txHash) =>
  TX_HASH_PATTERN.test(normalizeTransactionHash(txHash));

/** Same order of checks as the backend, so both sides report the same first failure. */
const checkTxHash = (txHash) => {
  if (typeof txHash !== 'string' || txHash.trim().length === 0) {
    return failure('MISSING_TX_HASH');
  }

  const normalized = normalizeTransactionHash(txHash);
  if (!isValidTxHash(normalized)) {
    return failure('INVALID_TX_HASH');
  }

  return { ok: true, value: normalized };
};

const checkPayerInfo = (input) => {
  const { payerName, payerEmail } = input || {};

  if (payerName !== undefined && typeof payerName !== 'string') {
    return failure('INVALID_PAYER_NAME');
  }
  if (payerEmail !== undefined && typeof payerEmail !== 'string') {
    return failure('INVALID_PAYER_EMAIL');
  }

  const normalizedPayerName = (payerName && payerName.trim()) || undefined;
  const normalizedPayerEmail = (payerEmail && payerEmail.trim()) || undefined;

  if (normalizedPayerEmail && !PAYER_EMAIL_PATTERN.test(normalizedPayerEmail)) {
    return failure('INVALID_PAYER_EMAIL');
  }
  if (
    (normalizedPayerName ? normalizedPayerName.length : 0) > MAX_PAYER_FIELD_LENGTH ||
    (normalizedPayerEmail ? normalizedPayerEmail.length : 0) > MAX_PAYER_FIELD_LENGTH
  ) {
    return failure('PAYER_INFO_TOO_LONG');
  }

  return {
    ok: true,
    value: { payerName: normalizedPayerName, payerEmail: normalizedPayerEmail },
  };
};

/**
 * Turn a failed verify request into the shared message.
 *
 * Prefers the code the server sent so the wording stays identical even when the
 * two sides drift; falls back to the server text, then a generic message.
 */
const resolveVerificationError = (error, fallback = 'Verification failed') => {
  const data = (error && error.response && error.response.data) || {};

  if (data.code && VERIFICATION_MESSAGES[data.code]) {
    return VERIFICATION_MESSAGES[data.code];
  }

  return data.error || (error && error.message) || fallback;
};

/**
 * Parse an amount (string or number) into integer stroops (1e-7 units) using
 * exact string/BigInt fixed-point arithmetic, avoiding JavaScript floating-point
 * rounding artifacts.
 */
function parseToStroops(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      return null;
    }
  }

  const str = String(value).trim();
  if (str === '') {
    return null;
  }

  const match = /^([+-]?\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    return null;
  }

  const isNegative = match[1].startsWith('-');
  const rawInt = match[1].replace(/^[+-]/, '');
  const intPart = BigInt(rawInt);

  let fracStr = match[2] || '';
  let fracBig;

  if (fracStr.length > STROOP_PRECISION) {
    const keep = fracStr.slice(0, STROOP_PRECISION);
    const nextDigit = parseInt(fracStr[STROOP_PRECISION], 10);
    fracBig = BigInt(keep);
    if (nextDigit >= 5) {
      fracBig += 1n;
    }
  } else {
    fracStr = fracStr.padEnd(STROOP_PRECISION, '0');
    fracBig = BigInt(fracStr);
  }

  return (intPart * 10_000_000n + fracBig) * (isNegative ? -1n : 1n);
}

/**
 * Compare two Stellar amounts with an allowable delta, measured in stroops.
 */
function amountsMatch(expected, actual, toleranceStroops = 0) {
  if (!Number.isInteger(toleranceStroops) || toleranceStroops < 0) {
    return false;
  }

  if (typeof expected === 'string' && expected.trim() === '') {
    return false;
  }
  if (typeof actual === 'string' && actual.trim() === '') {
    return false;
  }

  const expectedStroops = parseToStroops(expected);
  const actualStroops = parseToStroops(actual);

  if (expectedStroops === null || actualStroops === null) {
    return false;
  }

  const delta =
    expectedStroops >= actualStroops
      ? expectedStroops - actualStroops
      : actualStroops - expectedStroops;

  return delta <= BigInt(toleranceStroops);
}

function resolvePaymentAsset(fields) {
  const { assetType, assetCode, assetIssuer } = fields || {};
  if (assetType === 'native') {
    return { kind: 'native', code: NATIVE_ASSET_CODE };
  }

  const code = (assetCode || '').trim();
  const issuer = (assetIssuer || '').trim();

  if (!issuer) {
    return { kind: 'unpinned', code };
  }

  return { kind: 'credit', code, issuer };
}

function resolveInvoiceAsset(fields) {
  const { assetCode, assetIssuer } = fields || {};
  const code = (assetCode || '').trim();
  const issuer = (assetIssuer || '').trim();

  if (code === NATIVE_ASSET_CODE && !issuer) {
    return { kind: 'native', code: NATIVE_ASSET_CODE };
  }

  if (!issuer) {
    return { kind: 'unpinned', code };
  }

  return { kind: 'credit', code, issuer };
}

function assetsMatch(invoice, payment) {
  if (invoice.kind === 'unpinned' || payment.kind === 'unpinned') {
    return false;
  }

  if (invoice.kind === 'native' || payment.kind === 'native') {
    return invoice.kind === 'native' && payment.kind === 'native';
  }

  return invoice.code === payment.code && invoice.issuer === payment.issuer;
}

function normalizeMemo(memo) {
  return typeof memo === 'string' ? memo : '';
}

function assetCodeOf(operation) {
  return operation.asset_type === 'native' ? 'XLM' : operation.asset_code || '';
}

/**
 * Verify a Horizon transaction against expected payment parameters.
 * Same check order and rejection codes as backend payment-verification.ts.
 */
function verifyHorizonPayment(input) {
  const hashCheck = checkTxHash(input && input.txHash);
  if (!hashCheck.ok) {
    return hashCheck;
  }

  const { expected, transaction, operations, network } = input || {};

  if (expected && expected.network && network && expected.network !== network) {
    return failure('NETWORK_MISMATCH');
  }

  const paymentOp = (operations || []).find((operation) => operation.type === 'payment');
  if (!paymentOp) {
    return failure('NO_PAYMENT_OPERATION');
  }

  if (normalizeMemo(transaction && transaction.memo) !== normalizeMemo(expected && expected.memo)) {
    return failure('MEMO_MISMATCH');
  }

  if (paymentOp.to !== (expected && expected.destination)) {
    return failure('DESTINATION_MISMATCH');
  }

  if (!amountsMatch(expected && expected.amount, paymentOp.amount, 0)) {
    return failure('AMOUNT_MISMATCH');
  }

  const invoiceAsset = resolveInvoiceAsset({
    assetCode: expected && expected.assetCode,
    assetIssuer: expected && expected.assetIssuer,
  });
  const paidAsset = resolvePaymentAsset({
    assetType: paymentOp.asset_type,
    assetCode: paymentOp.asset_code,
    assetIssuer: paymentOp.asset_issuer,
  });

  if (!assetsMatch(invoiceAsset, paidAsset)) {
    return failure('ASSET_MISMATCH');
  }

  const paidAssetCode = assetCodeOf(paymentOp);

  return {
    ok: true,
    value: {
      txHash: hashCheck.value,
      from: paymentOp.from || '',
      to: paymentOp.to || '',
      amount: paymentOp.amount || '',
      assetCode: paidAssetCode,
      assetIssuer: paymentOp.asset_type === 'native' ? undefined : paymentOp.asset_issuer,
      memo: normalizeMemo(transaction && transaction.memo),
    },
  };
}

module.exports = {
  STROOP_PRECISION,
  VERIFICATION_MESSAGES,
  failure,
  isValidTxHash,
  normalizeTransactionHash,
  checkTxHash,
  checkPayerInfo,
  resolveVerificationError,
  parseToStroops,
  amountsMatch,
  resolvePaymentAsset,
  resolveInvoiceAsset,
  assetsMatch,
  verifyHorizonPayment,
};
