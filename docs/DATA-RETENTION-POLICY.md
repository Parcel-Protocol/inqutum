# Demo Data Retention & Isolation Policy (Issue #33, Phase D)

## 1. Overview

The public Quittance demo is an open sandbox environment intended for evaluation, developer testing, and interactive payment verification on Stellar Testnet. Because the demo is publicly accessible without individual merchant signups, unmanaged invoice records and customer data can accumulate, consuming memory and disk resources while posing privacy risks.

This policy defines the lifecycle, retention windows, isolation boundaries, and automated purge strategy for demo data.

## 2. Retention Windows

| Record Type | Retention Window | Purge Trigger | In-Flight Protection |
|---|---|---|---|
| Settled Invoices (`PAID`) | 24 Hours | Age > 24 hours | N/A (Already fulfilled) |
| Cancelled Invoices (`CANCELLED`) | 24 Hours | Age > 24 hours | N/A (Terminal state) |
| Expired Invoices (`EXPIRED`) | 24 Hours | Age > 24 hours | N/A (Terminal state) |
| Active Pending Invoices (`PENDING`) | Until Expiry | Age > 24h AND `expires_at <= NOW()` | **Protected**: Never purged while active and unexpired |
| Email Delivery Queue Logs | 48 Hours | Age > 48 hours | PENDING/PROCESSING items preserved |
| Idempotency Records | 24 Hours | Window expires | Automatically evicted |

## 3. Preservation of In-Flight Customer Sessions

A critical requirement of the purge strategy is that **active payment sessions are never disrupted**:
- When a buyer scans a QR code or opens a checkout link, the invoice status is `PENDING` with an `expiresAt` timestamp (default: 7 days or specified window).
- The retention purge algorithm checks both `created_at` age and status:
  ```sql
  DELETE FROM invoices
  WHERE created_at <= cutoff
    AND (
      status IN ('PAID', 'EXPIRED', 'CANCELLED')
      OR (status = 'PENDING' AND expires_at <= NOW())
    );
  ```
- If an invoice is still within its valid payment window, it is immune to retention deletion.

## 4. Privacy & PII Protection

To protect users entering personal details during public demos:
1. **Email Redaction**: Public invoice lookup endpoints redact customer and payer email addresses (e.g. `j***@example.com`) when accessed without authenticated seller ownership credentials.
2. **Ephemeral In-Memory State**: In MVP demo mode, all data resides in process memory and can be instantly cleared or purged via `purgeStaleInvoices()`.
3. **Database Cleanup Utility**: In persistent Postgres deployments, `backend/scripts/purge-demo-data.ts` can be scheduled via cron (e.g. `0 * * * *` hourly) or invoked via container maintenance tasks.

## 5. Automated Execution

To trigger an on-demand or automated purge:
```bash
# In backend directory (defaults to 24 hours)
npm run purge:demo

# Or specify custom retention hours (e.g. 12 hours)
npx tsx scripts/purge-demo-data.ts 12
```
