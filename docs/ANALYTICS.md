# Privacy-Preserving Analytics

## Overview

Inqutum collects privacy-safe analytics to give maintainers operational insights without exposing private user data, secrets, or sensitive payload content.

## Design Principles

1. **Aggregate by safe dimensions only** — operation type, status, time window, asset type, and stable error codes
2. **Never store raw sensitive values** — no wallet addresses, emails, transaction hashes, or amounts
3. **Use counts, rates, and percentiles** — never raw values
4. **Retention windows** — bound memory and disk usage (default: 7 days)

## Safe Dimensions

| Dimension | Values | Description |
|-----------|--------|-------------|
| `operation` | `invoice_create`, `horizon_verify`, `email_enqueue`, `import_row`, `search_index`, `payment_verify`, `dashboard_list`, `auth_challenge` | The quota operation or API endpoint category |
| `status` | `success`, `failure`, `quota_exceeded`, `rate_limited` | Outcome of the operation |
| `timeWindow` | `YYYY-MM-DDTHH:00:00.000Z` | Hourly bucket key |
| `assetType` | `native`, `credit` | Asset class (never the specific asset code or issuer) |
| `errorCode` | Stable machine-readable codes | Error category (never user input) |

## Metrics Exposed

- **Request counts** by operation and status
- **Success rate** percentages
- **Quota exhaustion** counts
- **Rate limiting** counts
- **Latency percentiles** (p50, p95, p99) in milliseconds
- **Unique actor count** (cardinality via one-way hash, not identities)
- **Top error codes** (top 5 by frequency)

## Privacy Guarantees

- **No raw actor identities** — only SHA-256 hashes (truncated to 16 chars) for cardinality counting
- **No raw request/response bodies** — only safe dimension values
- **No wallet addresses, emails, or transaction hashes** — never stored or exported
- **No raw latency values** — only percentiles are computed and exported
- **Error codes are stable** — machine-readable strings, never user input

## API Endpoints

All endpoints require a maintainer token (`analytics:read` or `analytics:clear` permission).

### GET /api/analytics/summary

Returns aggregated analytics for the requested time range.

**Query Parameters:**
- `operation` (optional): Filter by a specific operation type
- `from` (optional): ISO datetime for the start of the range
- `to` (optional): ISO datetime for the end of the range

**Response:**
```json
{
  "success": true,
  "data": {
    "generatedAt": "2026-09-29T12:00:00.000Z",
    "retentionHours": 168,
    "totalEvents": 150,
    "aggregates": [
      {
        "operation": "invoice_create",
        "timeWindow": "2026-09-29T12:00:00.000Z",
        "totalRequests": 50,
        "successCount": 45,
        "failureCount": 3,
        "quotaExceededCount": 2,
        "rateLimitedCount": 0,
        "successRate": 0.9,
        "p50LatencyMs": 120,
        "p95LatencyMs": 350,
        "p99LatencyMs": 500,
        "uniqueActors": 12,
        "topErrorCodes": [
          { "code": "QUOTA_EXCEEDED", "count": 2 }
        ]
      }
    ]
  }
}
```

### GET /api/analytics/operations

Returns the list of tracked operations and current bucket counts.

**Response:**
```json
{
  "success": true,
  "data": {
    "operations": ["invoice_create", "horizon_verify", ...],
    "retentionHours": 168,
    "bucketCount": 24
  }
}
```

### POST /api/analytics/clear

Clears all analytics data. Requires `analytics:clear` permission.

**Response:**
```json
{
  "success": true,
  "data": { "cleared": true },
  "message": "Analytics data cleared"
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYTICS_RETENTION_HOURS` | `168` (7 days) | How long to retain aggregated analytics data |

## Implementation Notes

- The default implementation is in-memory and resets on restart
- The `AnalyticsStore` interface is storage-shaped so a Redis/Postgres implementation can be substituted
- Events are aggregated into hourly buckets by operation and time window
- Old buckets are evicted automatically based on the retention window
- A hard cap of 30 days of buckets bounds memory usage

## Testing

```bash
cd backend
npm test -- --test-name-pattern='analytics'
npm run typecheck
```
