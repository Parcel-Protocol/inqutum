# Resilient External Reference Verification with Retry Policy

External references (`stellar_transaction`, `anchor_sep24_transfer`, `webhook_callback_delivery`, `custody_settlement_attestation`) are verified with per-attempt deadlines, exponential backoff retries, staleness and schema validation guards, and persistent verification metadata.

## Verification Lifecycle & Failure States

- **States**: `PENDING` -> `RETRY_SCHEDULED` -> `VERIFIED` | `FAILED_TERMINAL`
- **Retryable Failure Codes**:
  - `SOURCE_TIMEOUT` (per-attempt deadline exceeded; aborted via `AbortController`)
  - `SOURCE_UNREACHABLE` (transient network or 5xx error)
  - `REFERENCE_PENDING_UPSTREAM` (upstream finality still pending)
- **Non-Retryable Terminal Failure Codes**:
  - `REFERENCE_MALFORMED_INPUT` (fails before network call)
  - `MALFORMED_SOURCE_RESPONSE` (missing/invalid `observedTimestamp`, `status`, `ledgerSequence`, or `settledAmount`)
  - `STALE_SOURCE_DATA` (timestamp older than `maxStalenessMs` or post-dated beyond `allowedClockSkewMs`)
  - `REFERENCE_REJECTED_BY_SOURCE` (explicit rejection or amount/asset mismatch)
  - `RETRY_EXHAUSTED` (all `maxAttempts` exhausted; records `rootCauseCode` and recovery hint)

## Persistence & Endpoints

- Service: `ExternalReferenceVerificationService` in `backend/src/services/external-reference-verification.ts`
- Endpoints:
  - `POST /api/ops/external-references/verify`
  - `GET /api/ops/external-references/:id`

## Validation

```bash
cd backend
npx tsx --test tests/external-reference-verification.test.ts
```
