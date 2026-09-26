/**
 * Machine-readable public API contract (issue #55).
 *
 * The drift problem this solves: Express routes are easy to add and impossible
 * to review by eye, so a response shape can change with nothing but a handler
 * edit. This file is the declared surface, and `tests/api-contract.test.ts`
 * walks the real router and fails if the two disagree in either direction:
 *
 *   - a route that exists but is not declared here, or
 *   - a route declared here that does not exist.
 *
 * That second direction is the one that earns its keep. Documentation that
 * silently outlives the code it describes is worse than none, because callers
 * keep building on a promise the server no longer makes.
 *
 * Error codes are not invented here. Each one is either a key in
 * `DOMAIN_ERROR_TAXONOMY` or a literal emitted by a route, and the test suite
 * rejects this file if a code appears that the server never sends — the same
 * drift rule applied one level down.
 *
 * Paths are relative to the `/api` mount point. Auth values:
 *
 *   'public'  no credential
 *   'admin'   `Authorization: Bearer $JOBS_ADMIN_TOKEN`
 *
 * Code: `backend/src/api/api-contract.ts`. Prose: `docs/API.md`.
 */

export type ApiAuth = 'public' | 'admin';

export interface ApiRouteContract {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to the `/api` mount, e.g. `/invoices/:id`. */
  path: string;
  summary: string;
  auth: ApiAuth;
  /** Present when the route returns a cursor or offset page. */
  pagination?: { style: 'cursor' | 'offset'; params: string[] };
  /** Notable non-2xx responses worth documenting beyond the shared envelope. */
  errors?: Array<{ status: number; code: string; when: string }>;
}

export const API_MOUNT = '/api';

/** Every route, in the order a caller meets them. */
export const API_CONTRACT: ApiRouteContract[] = [
  // ---------------------------------------------------------------- health
  {
    method: 'GET',
    path: '/health',
    summary: 'Liveness probe. Reports the storage mode backing the server.',
    auth: 'public',
  },
  {
    method: 'GET',
    path: '/ready',
    summary: 'Readiness probe. Checks the database before accepting traffic.',
    auth: 'public',
  },

  // -------------------------------------------------------------- invoices
  {
    method: 'POST',
    path: '/invoices',
    summary: 'Create an invoice. `externalId` is accepted here for import parity and makes the call idempotent.',
    auth: 'public',
    errors: [
      { status: 400, code: 'VALIDATION_FAILED', when: 'the body fails invoiceSchema' },
      { status: 400, code: 'SELLER_REQUIRED', when: 'sellerPublicKey is absent or unusable' },
    ],
  },
  {
    method: 'GET',
    path: '/invoices',
    summary: 'List invoices for a seller, newest first.',
    auth: 'public',
    pagination: { style: 'cursor', params: ['cursor', 'limit', 'sellerPublicKey'] },
    errors: [
      { status: 400, code: 'SELLER_REQUIRED', when: 'the sellerPublicKey query parameter is missing' },
      { status: 400, code: 'INVALID_CURSOR', when: 'the cursor is malformed or from a different query' },
    ],
  },
  {
    method: 'GET',
    path: '/invoices/stats',
    summary: 'Aggregate counts and totals for a seller.',
    auth: 'public',
    errors: [{ status: 400, code: 'SELLER_REQUIRED', when: 'the sellerPublicKey query parameter is missing' }],
  },
  {
    method: 'GET',
    path: '/invoices/:id',
    summary: 'Fetch one invoice. A PENDING invoice past its expiry is returned as EXPIRED.',
    auth: 'public',
    errors: [{ status: 404, code: 'INVOICE_NOT_FOUND', when: 'no invoice has that id' }],
  },
  {
    method: 'GET',
    path: '/invoices/:id/payment-info',
    summary: 'Everything a payer needs to pay: amount, asset, memo and expiry.',
    auth: 'public',
    errors: [{ status: 404, code: 'INVOICE_NOT_FOUND', when: 'no invoice has that id' }],
  },
  {
    method: 'POST',
    path: '/invoices/:id/cancel',
    summary: 'Cancel a PENDING invoice. Terminal; a cancelled invoice cannot be paid.',
    auth: 'public',
    errors: [
      { status: 404, code: 'INVOICE_NOT_FOUND', when: 'no invoice has that id' },
      { status: 400, code: 'INVOICE_CANNOT_CANCEL', when: 'the invoice is already paid, expired or cancelled' },
    ],
  },
  {
    method: 'POST',
    path: '/invoices/:id/verify',
    summary: 'Verify a payment against an invoice. Read-only with respect to the invoice.',
    auth: 'public',
    errors: [
      { status: 404, code: 'INVOICE_NOT_FOUND', when: 'no invoice has that id' },
      { status: 400, code: 'MISSING_TX_HASH', when: 'txHash is absent' },
      { status: 400, code: 'INVALID_TX_HASH', when: 'txHash is not 64 hex characters' },
      { status: 404, code: 'TRANSACTION_NOT_FOUND', when: 'Horizon has no such transaction yet' },
      { status: 503, code: 'HORIZON_UNAVAILABLE', when: 'Horizon is unreachable' },
    ],
  },
  {
    method: 'POST',
    path: '/invoices/:id/simulate-payment',
    summary: 'Simulate a payment against the network. Does not mutate the invoice.',
    auth: 'public',
    errors: [
      { status: 404, code: 'INVOICE_NOT_FOUND', when: 'no invoice has that id' },
      { status: 503, code: 'HORIZON_UNAVAILABLE', when: 'Horizon is unreachable' },
    ],
  },

  // ---------------------------------------------------------------- import
  {
    method: 'POST',
    path: '/imports/invoices',
    summary:
      'Bulk import invoices from JSON or CSV. Dry run by default; pass `dryRun: false` to write. `maxRows` may only tighten the server cap.',
    auth: 'public',
    errors: [
      { status: 400, code: 'INVALID_IMPORT_REQUEST', when: 'the request body is not a valid import request' },
      { status: 400, code: 'INVALID_IMPORT_PAYLOAD', when: 'the payload is not parseable JSON or CSV, or exceeds maxRows' },
    ],
  },

  // ----------------------------------------------------------------- audit
  {
    method: 'GET',
    path: '/invoices/:id/audit-trail',
    summary: 'Audit events recorded for one invoice, oldest first.',
    auth: 'public',
    errors: [{ status: 404, code: 'INVOICE_NOT_FOUND', when: 'no invoice has that id' }],
  },
  {
    method: 'GET',
    path: '/audit/events',
    summary: 'Query audit events by action, entity, actor or time window.',
    auth: 'public',
    pagination: { style: 'offset', params: ['limit', 'offset'] },
  },
  {
    method: 'GET',
    path: '/audit/export',
    summary: 'Export the audit trail as a downloadable document.',
    auth: 'public',
  },

  // ---------------------------------------------------------------- export
  {
    method: 'POST',
    path: '/exports',
    summary: 'Create an export job for a seller. Artifacts expire on their own retention window.',
    auth: 'public',
    errors: [{ status: 400, code: 'INVALID_EXPORT_REQUEST', when: 'sellerPublicKey is missing or malformed' }],
  },
  {
    method: 'GET',
    path: '/exports/:id',
    summary: 'Fetch an export and its download URL once ready.',
    auth: 'public',
    errors: [
      { status: 404, code: 'EXPORT_NOT_FOUND', when: 'no export has that id' },
      { status: 410, code: 'EXPORT_EXPIRED', when: 'the artifact is past its retention window' },
      { status: 403, code: 'EXPORT_FORBIDDEN', when: 'the requester does not own the export' },
    ],
  },

  // --------------------------------------------------------- notifications
  {
    method: 'GET',
    path: '/notifications',
    summary: 'List notifications for a recipient.',
    auth: 'public',
    pagination: { style: 'offset', params: ['limit', 'offset'] },
    errors: [{ status: 400, code: 'RECIPIENT_REQUIRED', when: 'the recipient query parameter is missing' }],
  },
  {
    method: 'GET',
    path: '/notifications/unread-count',
    summary: 'Unread count for a recipient.',
    auth: 'public',
    errors: [{ status: 400, code: 'RECIPIENT_REQUIRED', when: 'the recipient query parameter is missing' }],
  },
  {
    method: 'POST',
    path: '/notifications/:id/read',
    summary: 'Mark one notification read.',
    auth: 'public',
    errors: [{ status: 404, code: 'NOTIFICATION_NOT_FOUND', when: 'no notification has that id' }],
  },
  {
    method: 'POST',
    path: '/notifications/read-all',
    summary: 'Mark every notification for a recipient read.',
    auth: 'public',
    errors: [{ status: 400, code: 'RECIPIENT_REQUIRED', when: 'the recipient query parameter is missing' }],
  },

  // -------------------------------------------------------- observability
  {
    method: 'GET',
    path: '/observability/metrics',
    summary: 'Latency and error metrics as JSON.',
    auth: 'public',
  },
  {
    method: 'GET',
    path: '/metrics',
    summary: 'The same metrics in Prometheus text format.',
    auth: 'public',
  },

  // ------------------------------------------------------------------ jobs
  {
    method: 'GET',
    path: '/jobs',
    summary: 'List background jobs with status and retry state.',
    auth: 'admin',
    pagination: { style: 'offset', params: ['status', 'type', 'limit', 'offset'] },
    errors: [
      { status: 401, code: 'UNAUTHORIZED', when: 'the admin token is missing or wrong' },
      { status: 403, code: 'JOBS_ADMIN_DISABLED', when: 'JOBS_ADMIN_TOKEN is unset' },
    ],
  },
  {
    method: 'GET',
    path: '/jobs/:id',
    summary: 'Fetch one job, including its errors.',
    auth: 'admin',
    errors: [
      { status: 401, code: 'UNAUTHORIZED', when: 'the admin token is missing or wrong' },
      { status: 404, code: 'JOB_NOT_FOUND', when: 'no job has that id' },
    ],
  },
  {
    method: 'POST',
    path: '/jobs/:id/retry',
    summary: 'Requeue a dead-lettered job. Idempotent per job.',
    auth: 'admin',
    errors: [
      { status: 401, code: 'UNAUTHORIZED', when: 'the admin token is missing or wrong' },
      { status: 404, code: 'JOB_NOT_FOUND', when: 'no job has that id' },
      { status: 409, code: 'JOB_NOT_DEAD', when: 'the job is not in the dead-letter set' },
    ],
  },

  // ------------------------------------------------------------------- ops
  {
    method: 'GET',
    path: '/ops/health',
    summary: 'Maintainer health report: dead jobs, stale work, expiry drift, server errors.',
    auth: 'admin',
    errors: [
      { status: 401, code: 'UNAUTHORIZED', when: 'the admin token is missing or wrong' },
      { status: 403, code: 'JOBS_ADMIN_DISABLED', when: 'JOBS_ADMIN_TOKEN is unset' },
    ],
  },

  // --------------------------------------------------------------- stellar
  {
    method: 'GET',
    path: '/stellar/account',
    summary: 'Account balances and sequence for an address.',
    auth: 'public',
    errors: [
      { status: 400, code: 'VALIDATION_FAILED', when: 'the address query parameter is malformed' },
      { status: 503, code: 'HORIZON_UNAVAILABLE', when: 'Horizon is unreachable' },
    ],
  },
  {
    method: 'GET',
    path: '/stellar/payments',
    summary: 'Recent payments for an account.',
    auth: 'public',
    errors: [
      { status: 400, code: 'VALIDATION_FAILED', when: 'the address query parameter is malformed' },
      { status: 503, code: 'HORIZON_UNAVAILABLE', when: 'Horizon is unreachable' },
    ],
  },
  {
    method: 'GET',
    path: '/stellar/transaction/:hash',
    summary: 'Fetch one transaction by hash.',
    auth: 'public',
    errors: [
      { status: 400, code: 'INVALID_TX_HASH', when: 'the hash is not 64 hex characters' },
      { status: 404, code: 'TRANSACTION_NOT_FOUND', when: 'Horizon has no such transaction' },
    ],
  },
  {
    method: 'POST',
    path: '/stellar/verify-payment',
    summary: 'Verify a payment without an invoice, for reconciliation.',
    auth: 'public',
    errors: [
      { status: 400, code: 'MISSING_TX_HASH', when: 'txHash is absent' },
      { status: 400, code: 'INVALID_TX_HASH', when: 'txHash is not 64 hex characters' },
    ],
  },

  // --------------------------------------------------------- reconciliation
  {
    method: 'POST',
    path: '/payment/sync',
    summary: 'Run a manual payment-monitor sync. Intended for maintainers and tests.',
    auth: 'public',
    errors: [{ status: 500, code: 'INTERNAL_ERROR', when: 'the sync throws' }],
  },
];

/** `GET /invoices/:id` for lookups by key. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export const API_CONTRACT_KEYS = API_CONTRACT.map((r) => routeKey(r.method, r.path));

/** Look up a declared route, if any. */
export function findRoute(method: string, path: string): ApiRouteContract | undefined {
  return API_CONTRACT.find((r) => routeKey(r.method, r.path) === routeKey(method, path));
}

/**
 * Routes gated behind the admin token, derived from the contract rather than
 * restated, so the two cannot drift.
 */
export function adminRoutes(): string[] {
  return API_CONTRACT.filter((r) => r.auth === 'admin').map((r) => routeKey(r.method, r.path));
}

/** Every error code the contract claims the server can return. */
export function contractErrorCodes(): string[] {
  return [...new Set(API_CONTRACT.flatMap((r) => (r.errors ?? []).map((e) => e.code)))].sort();
}
