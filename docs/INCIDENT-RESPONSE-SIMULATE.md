# Incident Response: Simulated Payment Exposure (Issue #34, Phase D)

## 1. Overview & Threat Model

The `ALLOW_SIMULATE` configuration enables `/invoices/:id/simulate-payment`, which bypasses Horizon blockchain verification and marks invoices as `PAID` with synthetic transaction hashes (`MOCK_TX_*`) and mock payer keys (`GXXXSIMULATEDPAYER...`).

If accidentally enabled or exposed in a production environment:
- Malicious actors could claim order fulfillment without sending real on-chain assets.
- Legitimate merchants could release goods or services based on unverified settlements.

## 2. Preventive Controls in Place

1. **Server Startup Invariant**: Both `server.ts` and `server-mvp.ts` invoke `assertSafeEnvironment()`. If `NODE_ENV === 'production'` and `ALLOW_SIMULATE === 'true'`, the process throws a fatal configuration error and terminates (`process.exit(1)`).
2. **Double-Layer Route Gating**: Both the router middleware (`isSimulationEnabled`) and the controller handler explicitly assert `process.env.NODE_ENV !== 'production'`. The endpoint returns HTTP 404 (Not Found) in production to avoid leaking route existence.
3. **Deployment Readiness Checks**: CI and deployment health checks (`deploymentReadiness()`) verify `simulationDisabled: true` before traffic cutover.
4. **Health Endpoint Sanitization**: `/api/health` does not leak internal environment variables or configuration keys.

## 3. Incident Detection & Triggers

An incident is declared if:
- Any invoice in production has `payment_tx_hash LIKE 'MOCK_TX_%'`.
- Any invoice has `payer_public_key = 'GXXXSIMULATEDPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'`.
- Telemetry or access logs report successful HTTP 200 responses to `/api/invoices/:id/simulate-payment`.

## 4. Incident Response Procedure

### Phase 1: Containment (Immediate)
1. **Force Environment Override**:
   Set `ALLOW_SIMULATE=false` across all production worker and API instances.
2. **Restart Services**:
   Cycle all server pods/processes to ensure `assertSafeEnvironment()` is verified.
3. **Edge / WAF Block**:
   Block all traffic matching path pattern `*/simulate-payment` at the reverse proxy or cloud CDN (Cloudflare/AWS WAF).

### Phase 2: Blast Radius Assessment
Execute the following audit query on production PostgreSQL:
```sql
SELECT id, seller_public_key, amount, asset_code, payment_tx_hash, created_at, paid_at
FROM invoices
WHERE payment_tx_hash LIKE 'MOCK_TX_%'
   OR payer_public_key = 'GXXXSIMULATEDPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
ORDER BY paid_at DESC;
```

### Phase 3: Remediation & Status Correction
1. For affected invoices that have not delivered goods/services:
   Revert status or mark as `CANCELLED` with audit metadata:
   ```sql
   UPDATE invoices
   SET status = 'CANCELLED',
       metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{incident_revocation}', '"ALLOW_SIMULATE_INCIDENT_REVERT"')
   WHERE payment_tx_hash LIKE 'MOCK_TX_%'
     AND status = 'PAID';
   ```
2. Notify impacted sellers/merchants with the exact invoice IDs and amounts that were falsely marked paid.
3. Invalidate any issued Quittance payment receipts referencing mock transaction hashes.

### Phase 4: Post-Mortem & Preventative Review
- Audit environment secret management pipelines (e.g. Doppler, Vault, GitHub Secrets, Render environment configs).
- Verify that deployment smoke tests continue to run `keeps simulate-payment hidden in production`.
