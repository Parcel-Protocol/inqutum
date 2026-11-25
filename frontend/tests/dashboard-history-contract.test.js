/**
 * Regression tests for the hardened dashboard history contract (issue #232).
 *
 * Tests success, validation, retry, and degraded-dependency behavior for the
 * dashboard data scoping boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DASHBOARD_ERROR_CODES,
  isValidSellerKey,
  isValidInvoiceStructure,
  belongsToSeller,
  isValidDashboardData,
  classifyDashboardError,
  describeDashboardError,
  safeDashboardFallback,
  validateSellerPublicKey,
  validateDashboardDataStructure,
  isDataOwnerMatch,
  executeDashboardDataContract,
} = require('../lib/dashboard-history-contract');

const ALICE = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const BOB = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const invoice = (overrides = {}) => ({
  id: 'inv-1',
  memo: 'QTN-1',
  amount: 25,
  assetCode: 'XLM',
  status: 'PENDING',
  sellerPublicKey: ALICE,
  ...overrides,
});

// ------------------------------------------------------------------ isValidSellerKey

test('isValidSellerKey accepts valid Stellar public keys', () => {
  assert.equal(isValidSellerKey(ALICE), true);
  assert.equal(isValidSellerKey(BOB), true);
});

test('isValidSellerKey rejects invalid keys', () => {
  assert.equal(isValidSellerKey(null), false);
  assert.equal(isValidSellerKey(undefined), false);
  assert.equal(isValidSellerKey(''), false);
  assert.equal(isValidSellerKey('not-a-key'), false);
  assert.equal(isValidSellerKey('G' + 'A'.repeat(54)), false); // wrong length
  assert.equal(isValidSellerKey(123), false);
  assert.equal(isValidSellerKey({}), false);
  assert.equal(isValidSellerKey([]), false);
});

test('isValidSellerKey trims whitespace before validation', () => {
  assert.equal(isValidSellerKey('  ' + ALICE + '  '), true);
  assert.equal(isValidSellerKey('  '), false);
});

// ----------------------------------------------------------- isValidInvoiceStructure

test('isValidInvoiceStructure accepts valid invoice objects', () => {
  assert.equal(isValidInvoiceStructure(invoice()), true);
  assert.equal(isValidInvoiceStructure({ sellerPublicKey: ALICE }), true);
});

test('isValidInvoiceStructure rejects malformed invoices', () => {
  assert.equal(isValidInvoiceStructure(null), false);
  assert.equal(isValidInvoiceStructure(undefined), false);
  assert.equal(isValidInvoiceStructure(''), false);
  assert.equal(isValidInvoiceStructure(123), false);
  assert.equal(isValidInvoiceStructure([]), false);
  assert.equal(isValidInvoiceStructure({}), false);
  assert.equal(isValidInvoiceStructure({ sellerPublicKey: null }), false);
  assert.equal(isValidInvoiceStructure({ sellerPublicKey: 123 }), false);
});

// -------------------------------------------------------------- belongsToSeller

test('belongsToSeller returns true for matching keys', () => {
  assert.equal(belongsToSeller(invoice(), ALICE), true);
});

test('belongsToSeller returns false for non-matching keys', () => {
  assert.equal(belongsToSeller(invoice(), BOB), false);
});

test('belongsToSeller handles invalid inputs safely', () => {
  assert.equal(belongsToSeller(null, ALICE), false);
  assert.equal(belongsToSeller(invoice(), null), false);
  assert.equal(belongsToSeller(invoice(), undefined), false);
  assert.equal(belongsToSeller(undefined, ALICE), false);
  assert.equal(belongsToSeller('not-an-invoice', ALICE), false);
  assert.equal(belongsToSeller([], ALICE), false);
  assert.equal(belongsToSeller(invoice(), 'invalid-key'), false);
});

test('belongsToSeller validates seller key format', () => {
  assert.equal(belongsToSeller(invoice(), 'not-a-key'), false);
  assert.equal(belongsToSeller(invoice(), 'G' + 'A'.repeat(54)), false);
});

// ------------------------------------------------------------- isValidDashboardData

test('isValidDashboardData accepts valid dashboard data structures', () => {
  assert.equal(isValidDashboardData({ owner: ALICE, invoices: [] }), true);
  assert.equal(isValidDashboardData({ owner: ALICE, invoices: [invoice()] }), true);
});

test('isValidDashboardData rejects malformed data', () => {
  assert.equal(isValidDashboardData(null), false);
  assert.equal(isValidDashboardData(undefined), false);
  assert.equal(isValidDashboardData(''), false);
  assert.equal(isValidDashboardData(123), false);
  assert.equal(isValidDashboardData([]), false);
  assert.equal(isValidDashboardData({}), false);
  assert.equal(isValidDashboardData({ owner: ALICE }), false); // missing invoices
  assert.equal(isValidDashboardData({ invoices: [] }), false); // missing owner
  assert.equal(isValidDashboardData({ owner: null, invoices: [] }), false);
  assert.equal(isValidDashboardData({ owner: ALICE, invoices: 'not-array' }), false);
  assert.equal(isValidDashboardData({ owner: 123, invoices: [] }), false);
});

// ----------------------------------------------------------- classifyDashboardError

test('classifyDashboardError returns INVALID_KEY for invalid key errors', () => {
  assert.equal(
    classifyDashboardError({ code: DASHBOARD_ERROR_CODES.INVALID_KEY }),
    DASHBOARD_ERROR_CODES.INVALID_KEY
  );
});

test('classifyDashboardError returns MALFORMED_DATA for malformed data errors', () => {
  assert.equal(
    classifyDashboardError({ code: DASHBOARD_ERROR_CODES.MALFORMED_DATA }),
    DASHBOARD_ERROR_CODES.MALFORMED_DATA
  );
});

test('classifyDashboardError returns OWNER_MISMATCH for owner mismatch errors', () => {
  assert.equal(
    classifyDashboardError({ code: DASHBOARD_ERROR_CODES.OWNER_MISMATCH }),
    DASHBOARD_ERROR_CODES.OWNER_MISMATCH
  );
});

test('classifyDashboardError returns DEGRADED for unknown errors', () => {
  assert.equal(classifyDashboardError(null), DASHBOARD_ERROR_CODES.DEGRADED);
  assert.equal(classifyDashboardError(undefined), DASHBOARD_ERROR_CODES.DEGRADED);
  assert.equal(classifyDashboardError({}), DASHBOARD_ERROR_CODES.DEGRADED);
  assert.equal(classifyDashboardError({ code: 'UNKNOWN' }), DASHBOARD_ERROR_CODES.DEGRADED);
});

// ---------------------------------------------------------- describeDashboardError

test('describeDashboardError returns appropriate messages', () => {
  assert.equal(
    describeDashboardError(DASHBOARD_ERROR_CODES.INVALID_KEY),
    'Invalid wallet address format.'
  );
  assert.equal(
    describeDashboardError(DASHBOARD_ERROR_CODES.MALFORMED_DATA),
    'Unable to process invoice data.'
  );
  assert.equal(
    describeDashboardError(DASHBOARD_ERROR_CODES.OWNER_MISMATCH),
    'Data does not match connected wallet.'
  );
  assert.equal(
    describeDashboardError(DASHBOARD_ERROR_CODES.DEGRADED),
    'Dashboard data temporarily unavailable.'
  );
});

test('describeDashboardError handles unknown codes', () => {
  assert.equal(describeDashboardError('UNKNOWN'), 'Dashboard data temporarily unavailable.');
});

// --------------------------------------------------------- safeDashboardFallback

test('safeDashboardFallback returns empty dashboard structure', () => {
  const fallback = safeDashboardFallback();
  assert.deepEqual(fallback.invoices, []);
  assert.equal(fallback.stats, null);
});

test('safeDashboardFallback always returns a new object', () => {
  const a = safeDashboardFallback();
  const b = safeDashboardFallback();
  assert.notEqual(a, b);
});

// ------------------------------------------------------ validateSellerPublicKey

test('validateSellerPublicKey returns valid for good keys', () => {
  const result = validateSellerPublicKey(ALICE);
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

test('validateSellerPublicKey returns error for invalid keys', () => {
  const result = validateSellerPublicKey('invalid');
  assert.equal(result.valid, false);
  assert.equal(result.error.code, DASHBOARD_ERROR_CODES.INVALID_KEY);
  assert.equal(result.error.message, 'Invalid wallet address format.');
});

test('validateSellerPublicKey handles null/undefined', () => {
  assert.equal(validateSellerPublicKey(null).valid, false);
  assert.equal(validateSellerPublicKey(undefined).valid, false);
});

// --------------------------------------------------- validateDashboardDataStructure

test('validateDashboardDataStructure returns valid for good data', () => {
  const result = validateDashboardDataStructure({ owner: ALICE, invoices: [] });
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

test('validateDashboardDataStructure returns error for malformed data', () => {
  const result = validateDashboardDataStructure({ owner: ALICE });
  assert.equal(result.valid, false);
  assert.equal(result.error.code, DASHBOARD_ERROR_CODES.MALFORMED_DATA);
  assert.equal(result.error.message, 'Unable to process invoice data.');
});

test('validateDashboardDataStructure handles null/undefined', () => {
  assert.equal(validateDashboardDataStructure(null).valid, false);
  assert.equal(validateDashboardDataStructure(undefined).valid, false);
});

// ---------------------------------------------------------- isDataOwnerMatch

test('isDataOwnerMatch returns true for matching owners', () => {
  assert.equal(isDataOwnerMatch({ owner: ALICE, invoices: [] }, ALICE), true);
});

test('isDataOwnerMatch returns false for non-matching owners', () => {
  assert.equal(isDataOwnerMatch({ owner: ALICE, invoices: [] }, BOB), false);
});

test('isDataOwnerMatch handles invalid inputs safely', () => {
  assert.equal(isDataOwnerMatch(null, ALICE), false);
  assert.equal(isDataOwnerMatch({ owner: ALICE, invoices: [] }, null), false);
  assert.equal(isDataOwnerMatch({ owner: ALICE, invoices: [] }, 'invalid'), false);
  assert.equal(isDataOwnerMatch({}, ALICE), false);
});

// ---------------------------------------------------- executeDashboardDataContract

test('executeDashboardDataContract returns invalid key error for bad key', () => {
  const deps = {
    scopeInvoicesToSeller: () => [],
    applyExpiryLifecycle: () => [],
    reconcileExpiryStats: () => null,
  };
  const result = executeDashboardDataContract(deps, { owner: ALICE, invoices: [] }, 'invalid');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DASHBOARD_ERROR_CODES.INVALID_KEY);
  assert.deepEqual(result.data, safeDashboardFallback());
});

test('executeDashboardDataContract returns empty data for null input', () => {
  const deps = {
    scopeInvoicesToSeller: () => [],
    applyExpiryLifecycle: () => [],
    reconcileExpiryStats: () => null,
  };
  const result = executeDashboardDataContract(deps, null, ALICE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, safeDashboardFallback());
  assert.equal(result.error, undefined);
});

test('executeDashboardDataContract returns malformed data error for bad structure', () => {
  const deps = {
    scopeInvoicesToSeller: () => [],
    applyExpiryLifecycle: () => [],
    reconcileExpiryStats: () => null,
  };
  const result = executeDashboardDataContract(deps, { owner: ALICE }, ALICE);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DASHBOARD_ERROR_CODES.MALFORMED_DATA);
  assert.deepEqual(result.data, safeDashboardFallback());
});

test('executeDashboardDataContract returns owner mismatch error', () => {
  const deps = {
    scopeInvoicesToSeller: () => [],
    applyExpiryLifecycle: () => [],
    reconcileExpiryStats: () => null,
  };
  const result = executeDashboardDataContract(deps, { owner: ALICE, invoices: [] }, BOB);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DASHBOARD_ERROR_CODES.OWNER_MISMATCH);
  assert.deepEqual(result.data, safeDashboardFallback());
});

test('executeDashboardDataContract processes valid data successfully', () => {
  const deps = {
    scopeInvoicesToSeller: (invoices, key) => invoices.filter((i) => i.sellerPublicKey === key),
    applyExpiryLifecycle: (invoices) => invoices,
    reconcileExpiryStats: (stats) => stats,
  };
  const data = { owner: ALICE, invoices: [invoice()], stats: { total_invoices: 1 } };
  const result = executeDashboardDataContract(deps, data, ALICE);
  assert.equal(result.ok, true);
  assert.equal(result.data.invoices.length, 1);
  assert.equal(result.data.stats.total_invoices, 1);
  assert.equal(result.error, undefined);
});

test('executeDashboardDataContract handles dependency errors with degraded fallback', () => {
  const deps = {
    scopeInvoicesToSeller: () => {
      throw new Error('Unexpected error');
    },
    applyExpiryLifecycle: () => [],
    reconcileExpiryStats: () => null,
  };
  const data = { owner: ALICE, invoices: [invoice()], stats: { total_invoices: 1 } };
  const result = executeDashboardDataContract(deps, data, ALICE);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DASHBOARD_ERROR_CODES.DEGRADED);
  assert.deepEqual(result.data, safeDashboardFallback());
});

test('executeDashboardDataContract calls dependencies in correct order', () => {
  const calls = [];
  const deps = {
    scopeInvoicesToSeller: (invoices, key) => {
      calls.push('scope');
      return invoices;
    },
    applyExpiryLifecycle: (invoices) => {
      calls.push('lifecycle');
      return invoices;
    },
    reconcileExpiryStats: (stats) => {
      calls.push('reconcile');
      return stats;
    },
  };
  const data = { owner: ALICE, invoices: [invoice()], stats: { total_invoices: 1 } };
  executeDashboardDataContract(deps, data, ALICE);
  assert.deepEqual(calls, ['scope', 'lifecycle', 'reconcile']);
});

test('executeDashboardDataContract preserves immutability of input data', () => {
  const deps = {
    scopeInvoicesToSeller: (invoices) => [...invoices],
    applyExpiryLifecycle: (invoices) => invoices,
    reconcileExpiryStats: (stats) => ({ ...stats }),
  };
  const data = { owner: ALICE, invoices: [invoice()], stats: { total_invoices: 1 } };
  const originalInvoices = [...data.invoices];
  const originalStats = { ...data.stats };
  executeDashboardDataContract(deps, data, ALICE);
  assert.deepEqual(data.invoices, originalInvoices);
  assert.deepEqual(data.stats, originalStats);
});
