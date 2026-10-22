# External Dependency Degradation & User-Safe Fallbacks

Modules:
- Matrix & Probes: [`backend/src/ops/dependency-degradation.ts`](../backend/src/ops/dependency-degradation.ts)
- Runtime Service & Middleware: [`backend/src/ops/degraded-mode.service.ts`](../backend/src/ops/degraded-mode.service.ts)
- API Integration: [`backend/src/routes/invoice.handlers.ts`](../backend/src/routes/invoice.handlers.ts) & [`backend/src/routes/ops.routes.ts`](../backend/src/routes/ops.routes.ts)

When third-party infrastructure (Stellar Horizon, PostgreSQL, Redis, SMTP/email) degrades or fails, the application must **never fail catastrophically** or leak internal error details.

### Core Principle
> **A degraded dependency must never produce a false positive.**
> - An invoice must **never** be marked as `PAID` without authoritative confirmation from the Stellar network.
> - An invoice must **never** be marked as expired or cancelled while payment verification is deferred.
> - A customer must **never** be told an email or notification was delivered if delivery was postponed.
> - The application will refuse or defer operations rather than guess an outcome.

---

## Capability Fallback Matrix

| Dependency | Capability | Mode | HTTP Status | Code | User-Safe Message | Retry-After |
|---|---|---|---|---|---|---|
| `stellar_horizon` | `payment.verify` | `defer` | **202 Accepted** | `VERIFICATION_DEFERRED` | *We could not reach the Stellar network to confirm this payment yet. Your invoice is unchanged; we will retry automatically.* | 30s |
| `postgres` | `invoice.create` | `refuse` | **503 Service Unavailable** | `STORAGE_UNAVAILABLE` | *Invoices cannot be created right now. Nothing was saved; please try again shortly.* | 15s |
| `postgres` | `invoice.read` | `refuse` | **503 Service Unavailable** | `STORAGE_UNAVAILABLE` | *Invoice data is temporarily unavailable. Please try again shortly.* | 15s |
| `postgres` | `payment.verify` | `refuse` | **503 Service Unavailable** | `STORAGE_UNAVAILABLE` | *Payments cannot be confirmed right now. Your payment is safe on-chain; please retry shortly.* | 15s |
| `postgres` | `export.create` | `refuse` | **503 Service Unavailable** | `STORAGE_UNAVAILABLE` | *Exports are temporarily unavailable. Please try again shortly.* | 15s |
| `redis_queue` | `job.enqueue` | `defer` | **202 Accepted** | `JOB_DEFERRED` | *Your request was accepted and will be processed when background processing recovers.* | 10s |
| `redis_queue` | `notification.send` | `defer` | **202 Accepted** | `NOTIFICATION_DEFERRED` | *Notifications are delayed. They will be delivered once processing recovers.* | 10s |
| `email_provider`| `notification.send` | `defer` | **202 Accepted** | `EMAIL_DEFERRED` | *Email delivery is delayed. The invoice link still works and can be shared directly.* | 60s |

---

## Dependency Runbooks

### <a id="stellar-horizon"></a>1. Stellar Horizon API (`stellar_horizon`)

- **Known Failure Modes:**
  - `HORIZON_TIMEOUT`: Network timeout or socket hang.
  - `HORIZON_UNREACHABLE`: DNS failure (`ENOTFOUND`) or connection refused (`ECONNREFUSED`).
  - `HORIZON_RATE_LIMITED`: HTTP 429 rate limit exceeded.
  - `HORIZON_5XX`: Bad Gateway (502) or Service Unavailable (503) from public Horizon nodes.
- **User-Safe Fallback:**
  - When Horizon is degraded or times out during `POST /api/invoices/:id/verify`:
    - The endpoint responds with **HTTP 202 Accepted**.
    - Sets header `Retry-After: 30`.
    - Returns `code: "VERIFICATION_DEFERRED"` and user-safe explanation.
    - **Crucial:** The invoice remains `PENDING`. It is neither marked `PAID` nor `EXPIRED`.
- **Operator Actions:**
  1. Check public Horizon cluster health: `curl -s https://horizon-testnet.stellar.org/fee_stats`
  2. If Horizon cluster is experiencing a sustained outage, switch to backup Horizon endpoint via `STELLAR_HORIZON_URL`.
  3. Clients polling with `Retry-After: 30` will resume settlement automatically once connectivity is restored.

---

### <a id="postgres"></a>2. PostgreSQL Database (`postgres`)

- **Known Failure Modes:**
  - `DB_UNREACHABLE`: Connection refused (`ECONNREFUSED`) or pool exhaustion.
  - `DB_READ_ONLY`: Primary failed over; active connection is attached to a read-only replica.
  - `DB_STATEMENT_TIMEOUT`: Queries exceed `statement_timeout`.
- **User-Safe Fallback:**
  - Responds with **HTTP 503 Service Unavailable**.
  - Sets header `Retry-After: 15`.
  - Code: `STORAGE_UNAVAILABLE`.
  - User message explicitly reassures the client: *"Nothing was saved; please try again shortly."* or *"Your payment is safe on-chain; please retry shortly."*
- **Operator Actions:**
  1. Inspect connection pool saturation: `SELECT count(*), state FROM pg_stat_activity GROUP BY state;`
  2. Verify primary write availability: `SELECT pg_is_in_recovery();`
  3. If primary was demoted, complete cluster failover promotion or resolve pool exhaustion.

---

### <a id="redis-queue"></a>3. Redis / Job Queue (`redis_queue`)

- **Known Failure Modes:**
  - `QUEUE_UNREACHABLE`: Connection refused or broken socket.
  - `QUEUE_READONLY`: Redis replica is read-only.
  - `QUEUE_OOM`: Memory limit exceeded (`OOM command not allowed`).
- **User-Safe Fallback:**
  - Responds with **HTTP 202 Accepted**.
  - Sets header `Retry-After: 10`.
  - Code: `JOB_DEFERRED` or `NOTIFICATION_DEFERRED`.
- **Operator Actions:**
  1. Check Redis memory usage: `redis-cli INFO memory`
  2. Evict dead queues or restart Redis background workers.

---

### <a id="email-provider"></a>4. Email Provider (`email_provider`)

- **Known Failure Modes:**
  - `EMAIL_AUTH`: SMTP 535 authentication failed.
  - `EMAIL_THROTTLED`: Provider rate limits (421/429).
  - `EMAIL_UNREACHABLE`: Network timeouts or connection refused.
- **User-Safe Fallback:**
  - Responds with **HTTP 202 Accepted**.
  - Sets header `Retry-After: 60`.
  - Code: `EMAIL_DEFERRED`.
  - User message notes that the direct payment link remains functional: *"Email delivery is delayed. The invoice link still works and can be shared directly."*
- **Operator Actions:**
  1. Check provider API status or rotate SMTP credentials.
  2. Outgoing emails are queued or checkpointed via side-effect recovery checkpoints and retried automatically.

---

## Standard Degraded HTTP Response Protocol

When an endpoint degrades, it supplies standard machine-readable and caching headers:

```http
HTTP/1.1 202 Accepted
Retry-After: 30
X-Degraded-Mode: true
X-Degraded-Dependency: stellar_horizon
X-Degraded-Capability: payment.verify
Content-Type: application/json

{
  "success": false,
  "code": "VERIFICATION_DEFERRED",
  "error": "We could not reach the Stellar network to confirm this payment yet. Your invoice is unchanged; we will retry automatically.",
  "degraded": true,
  "retryAfter": 30,
  "correlationId": "req-mvd190..."
}
```

---

## Operator Administration API

All degraded mode management endpoints require admin bearer authentication (`requireAdmin(options.adminToken)`):

### 1. View Degraded Mode Status & Capability Matrix
```http
GET /api/ops/degraded-mode/status
Authorization: Bearer <JOBS_ADMIN_TOKEN>
```

### 2. Set Manual Dependency Override (Incident Drills & Maintenance)
```http
POST /api/ops/degraded-mode/overrides
Authorization: Bearer <JOBS_ADMIN_TOKEN>
Content-Type: application/json

{
  "dependency": "stellar_horizon",
  "state": "down",
  "reason": "Horizon scheduled maintenance drill"
}
```

### 3. Clear Manual Override
```http
DELETE /api/ops/degraded-mode/overrides/stellar_horizon
Authorization: Bearer <JOBS_ADMIN_TOKEN>
```

### 4. Clear All Overrides
```http
DELETE /api/ops/degraded-mode/overrides
Authorization: Bearer <JOBS_ADMIN_TOKEN>
```

---

## Operational Edge Cases & Recovery

1. **Flapping Network Probes:**
   - Probes have a hard timeout (default 5000ms). Transient errors mark dependencies degraded (`latencyMs > threshold`) rather than down immediately, unless connection is refused or timed out.
2. **Precedence Rules (Refuse > Defer > Serve Stale):**
   - If multiple dependencies affecting a capability are down (e.g. Postgres and Horizon during payment verification), the strictest fallback wins: **Refuse (503)** beats **Defer (202)** because the invoice settlement cannot even be queried or stored.
3. **Safe Recovery:**
   - When a probe succeeds again, capability status immediately returns `allowed: true`.
   - No data migration is required; the degradation system is strictly stateless and in-memory with optional operator overrides.
