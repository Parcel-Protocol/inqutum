# Distributed Request Correlation Across API, Workers, and External Calls

This document specifies the end-to-end request correlation architecture across HTTP APIs, background job workers, and external outbound calls (Stellar Horizon RPC, transactional email delivery, and HTTP probes).

---

## 1. Architecture Overview

Tracing transactions, failures, retries, and latency bottlenecks requires deterministic correlation propagation across disparate boundaries:

```
[ Client / Webhook ]
        │  X-Correlation-ID: req-m123-abc (or generated)
        ▼
┌───────────────────────────────────────────────────────────┐
│ Express API Layer (`correlationMiddleware`)               │
│  - Sanitizes header (CRLF injection prevention, 128-char) │
│  - Establishes `AsyncLocalStorage` correlation context    │
│  - Echoes `X-Correlation-ID` & `X-Request-ID` in response │
│  - Injects `correlationId` into success/failure envelopes │
└───────┬───────────────────────────────────────────┬───────┘
        │                                           │
        ▼ (automatic context inheritance)           ▼ (outbound API dispatch)
┌───────────────────────────────────────┐   ┌───────────────────────────────────────────┐
│ Background Job Queue (`JobQueue`)     │   │ External Calls & HTTP Probes              │
│  - Durably enqueues `correlation_id`  │   │  - `correlatedFetch` (attaches headers)   │
│  - Preserved in PostgreSQL & Memory   │   │  - `probeJson` (probes with correlation)  │
└───────┬───────────────────────────────┘   │  - `createHttpApiTransport` (email)       │
        │                                   │  - Stellar Horizon AxiosClient Interceptor│
        ▼ (worker claim & execution)        └───────────────────────────────────────────┘
┌───────────────────────────────────────┐
│ Background Job Worker (`JobWorker`)   │
│  - Binds claimed job's correlationId  │
│  - Provides `ctx.correlationId`       │
│  - Preserves ID across all RETRIES    │
│  - Retains ID in Dead-Letter Queue    │
└───────────────────────────────────────┘
```

---

## 2. Core Components

### 2.1 Context Propagation (`backend/src/observability/correlation.ts`)
- Utilizes Node.js `node:async_hooks` `AsyncLocalStorage<CorrelationContext>`.
- Provides:
  - `runWithCorrelation(context, fn)`: Wraps asynchronous call trees with correlation metadata (`correlationId`, `source`, `metadata`).
  - `getCorrelationId()`: Safely retrieves the active correlation ID without passing parameters through every internal function signature.
  - `sanitizeCorrelationId(raw, prefix)`: Normalizes client input, strips CRLF (`\r\n`), quotes, control characters (`\x00-\x1F\x7F`), enforces 128-character limit, and provides deterministic fallback.

### 2.2 Express API Layer (`backend/src/observability/telemetry.ts` & `backend/src/types/api.ts`)
- `correlationMiddleware`:
  - Inspects incoming `X-Correlation-ID` and `X-Request-ID`.
  - Binds `req.correlationId` and `req.startTime`.
  - Sets outgoing response headers `X-Correlation-ID` and `X-Request-ID`.
  - Wraps downstream middleware/handlers in `runWithCorrelation`.
- Response envelopes (`sendSuccess`, `sendFailure`, `sendVerificationFailure`):
  - Automatically falls back to `getCorrelationId()` so all HTTP responses carry `{ correlationId: "..." }` even if omitted by the route handler.

### 2.3 Background Jobs (`backend/src/jobs/worker.ts` & `backend/src/jobs/job-types.ts`)
- `JobQueue.enqueue`: Automatically extracts `getCorrelationId()` if `options.correlationId` is omitted, linking background jobs directly to the initiating API request.
- `JobContext`: Exposes `correlationId: string` to handlers.
- `JobWorker.runOnce`: Executes handlers inside `runWithCorrelation({ correlationId, source: 'worker' })`.
- Retry Preservation: When a job fails and is scheduled for backoff, the `correlation_id` remains immutable in the job record. Subsequent retry attempts run under the exact same correlation ID.
- Requeueing: Requeuing a dead-lettered job via `requeueDead` preserves its initial correlation ID for end-to-end provenance.

### 2.4 External Outbound Calls
- `correlatedFetch`: Automatically injects `X-Correlation-ID` and `X-Request-ID` into outgoing HTTP requests.
- `scripts/http-probe.ts`: `probeJson` accepts `options.correlationId`, propagates it in probe headers across retries, and returns `correlationId` in `ProbeResult`.
- `backend/src/notifications/email-delivery.ts`:
  - `createHttpApiTransport`: Injects correlation headers into transactional HTTP requests.
  - `createSmtpTransport`: Injects headers into nodemailer/SMTP payloads.
  - Delivery Store: Records `correlationId` in delivery metadata for both successful and failed dispatches.
- Stellar Horizon RPC (`backend/src/config/stellar.ts`):
  - Automatically installs an Axios request interceptor on `StellarSdk.Horizon.AxiosClient` to propagate correlation headers on Horizon queries and transaction submissions.

---

## 3. Operational Paths

### 3.1 Normal Path
1. Client makes `POST /api/invoices` with `X-Correlation-ID: req-abc-123`.
2. Middleware accepts and sanitizes ID.
3. Handlers and services invoke DB queries and enqueue jobs.
4. Jobs inherit `req-abc-123`.
5. API responds with HTTP 201, headers `X-Correlation-ID: req-abc-123`, and body `correlationId: "req-abc-123"`.
6. Background worker processes job under `req-abc-123` and issues outbound webhooks/emails containing `X-Correlation-ID: req-abc-123`.

### 3.2 Failure Path
1. An unhandled exception or verification error occurs in an API handler, worker, or external call.
2. Structured logs emit `[req-abc-123] operation -> failure [code: ERROR_CODE]`.
3. API response envelope returns HTTP error status with `{ success: false, code: "...", correlationId: "req-abc-123" }`.
4. Operators can immediately grep logs, database entries, and external provider logs using `req-abc-123`.

### 3.3 Retry Path
1. An external dependency fails transiently (HTTP 429, 502, 503, 504, or network timeout).
2. For HTTP probes (`probeJson`), each backoff attempt sends the identical `X-Correlation-ID`.
3. For background jobs (`JobWorker`), each retry attempt records the failure in `job.errors` while preserving `job.correlationId`.
4. When the worker claims the job for attempt 2 or 3, `runOnce` restores the original correlation ID, preventing trace fragmentation across retry intervals.

### 3.4 Authorization Path
1. An unauthorized request hits a protected endpoint (e.g., maintainer routes `/api/jobs` without valid Bearer token).
2. The authorization gate rejects the request with HTTP 401 or 403.
3. The response includes `X-Correlation-ID` header and `{ success: false, code: "UNAUTHORIZED", correlationId: "..." }`.
4. For external probes or email delivery, if the upstream returns 401 or 403 (`auth` failure), the operation fails fast without retry and records the correlation ID for security auditing.

---

## 4. Operational Edge Cases

| Edge Case | Risk | Mitigation |
| --- | --- | --- |
| **CRLF Injection / Header Splitting** | Attacker sends `\r\nSet-Cookie: ...` in `X-Correlation-ID` to inject response headers. | `sanitizeCorrelationId` strips `\r`, `\n`, quotes, and control characters `[\x00-\x1F\x7F]`. |
| **High-Cardinality Unbounded Input** | Abusive clients send megabyte-sized IDs to exhaust memory or break log indexing. | `sanitizeCorrelationId` caps input to 128 characters max. Invalid/empty inputs fall back to generated IDs. |
| **Async Context Loss** | Asynchronous operations lose context across third-party event emitters or uninstrumented callbacks. | Handlers, worker runs, and external fetch wrappers execute within `runWithCorrelation(...)`. Helper functions fall back gracefully to `req.correlationId` or generate a scoped ID. |
| **Concurrent Execution Collisions** | Concurrent requests running in Node.js event loop overwrite shared state. | Uses Node's built-in `AsyncLocalStorage`, ensuring microtask and promise isolation without cross-talk. |

---

## 5. Recovery & Rollback Behavior

- **Zero-Migration Rollback**: The PostgreSQL database schema already provides the `correlation_id VARCHAR(100)` column on the `jobs` table (`db/schema.sql`). No schema migrations are introduced or required.
- **Backwards Compatibility**:
  - `Express.Request.correlationId` remains fully populated.
  - Existing response envelope schemas (`ApiSuccess`, `ApiFailure`) are preserved.
  - External endpoints that do not recognize `X-Correlation-ID` safely ignore custom `X-` headers per RFC 7230 / RFC 9110.
- **Reversion Safety**: In the event of an emergency rollback, reverting code changes introduces zero data corruption or orphaned records.
