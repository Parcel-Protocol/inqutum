# User-Facing Explanation Framework for Rejected Operations

Rejected operations return consistent, user-safe `RejectionExplanation` objects across backend APIs and frontend clients, explaining what happened and providing ordered, actionable recovery hints.

## Explanation Schema (`schemaVersion: '1.0'`)

Each rejected operation maps to a stable `reasonCode` and `category`:

- `VALIDATION`: `VALIDATION_FAILED`, `INVALID_PAYER_NAME`, `INVALID_PAYER_EMAIL`, `PAYER_INFO_TOO_LONG`, `INVALID_STATUS`, `INVALID_CURSOR`, `INVALID_TX_HASH`, `MISSING_TX_HASH`, `INVALID_POLICY_PROPOSAL`, `INVALID_TREND_EXPORT_REQUEST`, `REFERENCE_MALFORMED_INPUT`
- `POLICY`: `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `ASSET_NOT_ALLOWED`, `EXPIRY_OUT_OF_RANGE`, `ALLOW_LIST_VIOLATION`, `SIMULATION_DISABLED`
- `PERMISSION`: `UNAUTHORIZED_SELLER`, `SELLER_REQUIRED`, `PERMISSION_DENIED`, `ADMIN_TOKEN_REQUIRED`, `EXPORT_FORBIDDEN`, `TREND_EXPORT_FORBIDDEN`, `SENSITIVE_DIMENSION_FORBIDDEN`, `CAPABILITY_REQUIRED`, `APPROVAL_REQUIRED`, `CORS_ORIGIN_DENIED`, `IMPERSONATION_REJECTED`
- `STALE_STATE`: `STALE_STATE_CONFLICT`, `CONFLICT`, `INVOICE_EXPIRED`, `INVOICE_ALREADY_PAID`, `INVOICE_NOT_PENDING`, `INVOICE_CANNOT_CANCEL`, `INVOICE_NOT_FOUND`, `EXPORT_EXPIRED`, `CHECKPOINT_IN_PROGRESS`, `CHECKPOINT_IN_DOUBT`, `STALE_SOURCE_DATA`
- `SETTLEMENT`: `NO_PAYMENT_OPERATION`, `MEMO_MISMATCH`, `DESTINATION_MISMATCH`, `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `NETWORK_MISMATCH`
- `RATE_LIMIT`: `RATE_LIMITED`, `QUEUE_BACKPRESSURE_ACTIVE`
- `DEPENDENCY`: `HORIZON_UNAVAILABLE`, `TRANSACTION_NOT_FOUND`, `EXTERNAL_SOURCE_TIMEOUT`, `EXTERNAL_SOURCE_UNREACHABLE`
- `UNEXPECTED`: `UNEXPECTED_FAILURE` (safe fallback that strips SQL errors, stack traces, file paths, and secrets)

## Client & Server Integration

- **Backend**: `explainRejection` and `buildRejectedOperationEnvelope` in `backend/src/errors/rejection-explanation.ts`, plus `POST /api/ops/rejections/explain`.
- **Frontend**: `resolveRejectionExplanation` in `frontend/lib/rejection-explanation.js` and `frontend/components/ApiErrorState.tsx`.

## Validation

```bash
cd backend && npx tsx --test tests/rejection-explanation.test.ts
node --test frontend/tests/rejection-explanation.test.js
```
