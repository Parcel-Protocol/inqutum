# Stale-Cache & Stale-Index Detection with Automated Repair Recommendations

## Context & Architecture
In Inqutum, search indexing (`PermissionAwareSearchIndex`), seller dashboards, and aggregate statistics rely on asynchronous and in-memory read projections derived from the primary invoice database. Under network partitions, unhandled worker crashes, or high concurrency, projections can drift from storage truth.

The **Stale Projection Detection & Repair Service** (Issue #269) introduces active drift discovery, severity scoping, automated operator repair recommendations, and dual-mode reconciliation.

### Bounded Projection Cache

Read projections that are held in memory are backed by a **bounded cache** with the following properties:

- **Bounded size**: the cache holds at most `maxEntries` entries. When a new entry would exceed the bound, the least-recently-used entry is evicted. Eviction is never a correctness event: an evicted projection is simply re-derived from authoritative storage on the next read.
- **Explicit invalidation**: every write path that changes an invoice (status transition, attribute edit, deletion) invalidates the corresponding cache key *before* returning to the caller. Invalidation is by key (`invoice:<id>`) or by prefix (`seller:<id>:`) for aggregate views.
- **Stale detection**: each cache entry records the storage `version` (or `updatedAt` high-water mark) it was derived from. On read, an entry whose recorded version is older than the last known authoritative version for that key is treated as stale: it is not served, it is evicted, and the read falls through to storage. Staleness is also bounded by a configurable `maxAgeMs` TTL as a safety net for writes that bypass explicit invalidation.

## Drift Classification & Severity Model

1. **Status Drift (`STATUS_DRIFT`)**:
   - Storage marks an invoice `PAID`, `EXPIRED`, or `CANCELLED`, but projection still displays `PENDING`.
   - **Severity**: `CRITICAL` when an invoice is settled in storage but shows pending in projections, risking duplicate payments.
2. **Missing Projections (`MISSING_PROJECTION`)**:
   - Stored invoice exists in database but was never indexed into search.
   - **Severity**: `CRITICAL` for paid invoices; `WARNING` for pending invoices.
3. **Orphaned Projections (`ORPHANED_PROJECTION`)**:
   - Search index retains an entry whose source record was deleted or pruned.
   - **Severity**: `WARNING`.
4. **Attribute Mismatch (`ATTRIBUTE_MISMATCH`)**:
   - Currency code, amount, or memo divergence between storage and read projections.
   - **Severity**: `WARNING`.
5. **Stale Cache Entry (`STALE_CACHE_ENTRY`)**:
   - A bounded-cache entry whose recorded storage version is behind authoritative storage, or which exceeded `maxAgeMs`.
   - **Severity**: `WARNING`. Stale entries are self-healing on read; they are reported so operators can detect invalidation gaps.

## Operator Recommendations & Repair Actions

The service analyzes anomaly counts and assigns automated repair recommendations:
- **`IMMEDIATE_REPAIR`**: Applied when anomaly count < 100. In-memory projections are updated immediately in-line.
- **`REBUILD_PROJECTION`**: Recommended when structural index corruption or divergence between 100 and 500 records occurs.
- **`QUEUE_BACKGROUND_SYNC`**: Recommended when anomaly count > 500 to avoid blocking real-time HTTP request loops.

Repair of `STALE_CACHE_ENTRY` findings is performed by evicting the entry from the bounded cache; no index mutation is required.

## REST Endpoints

All stale-projection endpoints are admin-authenticated via `JOBS_ADMIN_TOKEN`. Requests without a valid token receive `401`; requests with a token that does not match `JOBS_ADMIN_TOKEN` receive `403`. Authorization is checked before any storage or cache access.

- `GET /api/ops/stale-projections/detect`: Returns full detection report with operator-visible evidence for every drifted record.
- `POST /api/ops/stale-projections/repair`: Executes repair in `{ mode: 'immediate' | 'queued' }` and returns structured execution evidence.

### Response Paths

- **Normal**: `200` with a report or repair evidence payload.
- **Failure**: if storage is unavailable during detection, the endpoint returns `503` with the partial evidence collected so far and does not mutate any projection.
- **Retry**: detection is read-only and safe to retry. Repair is idempotent; a retried repair re-evaluates drift and only touches keys that are still desynchronized, so a repair that timed out mid-flight can simply be re-submitted.

## Operational Edge Cases & Failure Modes

1. **Concurrent Writes During Repair**: Repairs update only desynchronized keys and reconcile against authoritative storage locks; newly created invoices are preserved. A write that lands between detection and repair causes the repair step to re-read the authoritative version and skip the key if it is already in sync.
2. **Reversibility / Rollback**: Because projections are strictly derived views of authoritative storage records, running repairs is idempotent and 100% reversible with zero financial loss. Evicting cache entries is always safe; the worst outcome is an extra storage read. To roll back a repair, clear the affected projection or cache keys and allow re-derivation from storage.
3. **Queue Overload**: If background reconciliation is queued, workers drain records with a concurrency limiter to prevent database connection starvation. When the queue is full, new queue requests are rejected with `429` rather than dropped silently.
4. **Cache Capacity Pressure**: If the working set exceeds `maxEntries`, hit rate falls but correctness is unaffected. Operators should watch for sustained eviction rates and raise the bound or shard by seller if needed.
5. **Missed Invalidation**: A write path that fails to invalidate leaves a stale entry; the version check on read and the `maxAgeMs` TTL bound how long it can be served. Detection reports these as `STALE_CACHE_ENTRY` so the gap can be fixed at the source.

## Verification

The following behaviors are covered by automated tests:
- LRU eviction keeps the cache at or below `maxEntries`.
- Explicit invalidation by key and by prefix removes the affected entries and no others.
- A cache entry with an older recorded version than storage is not served and is reported as `STALE_CACHE_ENTRY`.
- Entries past `maxAgeMs` are not served.
- Detection and repair endpoints return `401` without a token and `403` with a wrong token.
- Storage failure during detection returns `503` and performs no mutation.
- Repeating a repair produces no additional changes.

## Migration

The bounded cache wraps existing projection reads and keeps the public response shapes of the detection and repair endpoints unchanged. Existing callers that do not pass cache options receive the default bound and TTL. No storage schema changes are required; the recorded version is taken from the existing `updatedAt` field.
