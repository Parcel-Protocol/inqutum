# Historical Trend Export for Operational and Financial Metrics

Maintainers can export aggregated historical trends across financial/protocol settlement volume, invoice lifecycle counts, operational latency, failure rates, background job queues, and SLA breaches.

## Schema & Metadata Contract

Every export includes explicit schema versioning and generation metadata:

- **Schema ID**: `inqutum.historical-trend-export`
- **Schema Version**: `1.0.0` (`version: 1`)
- **Aggregation Windows (`granularity`)**: `hour`, `day`, `week` (ISO Monday UTC), `month`
- **Formats (`format`)**: `json`, `csv`
- **Truncation Metadata**: `truncated: boolean` and `truncationReasons` (`MAX_SOURCE_RECORDS_REACHED`, `MAX_BUCKETS_REACHED`)

## Privacy & Sensitive Dimension Protection

- **Maintainer Role Required**: Only actors with `role: 'maintainer'` or `'admin'` are permitted to generate historical trend exports (`403 TREND_EXPORT_FORBIDDEN` otherwise).
- **Sensitive Dimension Deny-List**: Private and PII dimensions (`customerEmail`, `customerName`, `payerEmail`, `payerName`, `sellerEmail`, `sellerName`, `sellerPublicKey`, `payerPublicKey`, `rawMemo`, `description`, `ip`, `userAgent`, `secret`, `privateKey`, `token`) are blocked with `403 SENSITIVE_DIMENSION_FORBIDDEN`.
- **Cohort Anonymization**: When `sellerCohort` is requested in `dimensions`, seller wallet keys are one-way hashed into `cohort_<sha256_prefix_8>`.

## API & CLI Usage

### HTTP Endpoint
- `POST /api/ops/trends/export` (requires `Authorization: Bearer <JOBS_ADMIN_TOKEN>`)
- `GET /api/ops/trends/export?granularity=day&format=json`

### CLI Command
```bash
cd backend
npm run export:trends -- --granularity day --format json
```

### Validation
```bash
cd backend
npx tsx --test tests/trend-export.test.ts
```
