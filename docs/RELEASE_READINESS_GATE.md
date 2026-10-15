# Release Readiness Gate & Rehearsal Verification

## Overview
In Inqutum, critical invoice settlement, payment proof verification, and financial accounting cannot tolerate broken migrations, secret leaks, missing deploy contracts, or unvalidated rollbacks.

The **Release Readiness Gate** (Issue #270) provides an automated preflight CI/CD checkpoint blocking deployment if any release readiness criteria are violated.

## The Four Gates

### 1. Migrations & Schema Convergence Gate
- **Idempotency**: All DDL definitions must support safe re-runs (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- **Destructive Operation Containment**: Prevents uncontained table or column drops without documented migration plans and transition notes.
- **Convergence**: Guarantees that applying the schema against existing databases converges to the declared target state without leaving orphaned constraints.

### 2. Security & Secret Leakage Gate
- **Secret Seed Scanning**: Automated scan of application source trees to ensure no Stellar secret keys (`S...`), private keys, or API tokens are hardcoded.
- **Template Injection & Content Safety**: Validates that dynamic invoice export documents (PDF/HTML) strictly sanitize user-controlled fields through HTML escaping.
- **PII Boundary Protection**: Confirms that notification pipelines, search indexes, and logs never ingest customer or payer PII.

### 3. Smoke Tests & Health Contract Gate
- **Liveness & Readiness**: Asserts `/health` and `/ready` HTTP contracts are pinned.
- **End-to-End Core Lifecycle**: Validates that `scripts/deploy-smoke.mjs` verifies creating and retrieving an invoice before marking a build ready.

### 4. Rollback & Disaster Recovery Rehearsal Gate
- **Read-Only Invariant Enforcement**: Evaluates state coherence against the four primary failure families: `missing`, `orphaned`, `duplicated`, and `inconsistent`.
- **Rehearsal Dry-Runs**: Executes dry-run rehearsals to verify that rolling back to a previous backup or schema point restores an uncorrupted state.

## CLI & CI Usage

```bash
# Full readable checklist report:
pnpm run release:gate

# CI blocking mode (exits non-zero if ANY gate fails):
pnpm run release:check

# Machine-readable JSON for release pipelines:
npx tsx scripts/release-readiness-gate.ts --json
```

## Operational Edge Cases & Failure Modes

1. **Uncontained Destructive DDL**: If a migration script contains raw `DROP TABLE` or `DROP COLUMN` without approved transition status, release is blocked immediately with remediation instructions.
2. **Missing Invariant Coverage**: If a database restore leaves orphan transactions without matching invoices, the rollback rehearsal gate flags `totalViolations > 0` and stops deployment.
3. **Partial Deployments**: If deploy smoke fails against a staging container, the release gate prevents traffic cutover.

## Rollback & Recovery Procedures

1. **Gate Failure Triage**: Inspect the CLI summary and `details` array to identify the offending gate.
2. **Schema Rollback**: If a schema migration is rejected, consult `docs/MIGRATIONS.md` and use the forward-fix notes associated with the planned action.
3. **Data Coherence Recovery**: Run `pnpm run db:validate` to generate an audit report of row-level invariant violations and apply designated remediations.
