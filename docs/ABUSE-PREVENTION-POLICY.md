# Abuse Prevention & Anti-Spam Policy (Issue #31, Phase D)

## 1. Threat Landscape & Objectives

Because the public Quittance demo operates without friction or mandatory merchant account creation, it presents three primary abuse vectors:
1. **Invoice Spam / Resource Exhaustion**: Automated scripts flooding the storage backend with hundreds of thousands of dummy invoices.
2. **Email Spam Relay**: Malicious actors triggering invoice and payment proof emails to arbitrary third-party email addresses without their consent.
3. **Horizon API Quota Depletion**: Rapid automated verification polls draining public Stellar Horizon quotas.

This document formalizes the multi-layered abuse defenses enforced across all public demo endpoints.

## 2. Multi-Layer Defense Matrix

| Abuse Vector | Control Layer | Enforcement Limit | HTTP Reaction |
|---|---|---|---|
| Rapid Invoice Creation | IP Rate Limiter | 10 invoices per 10 minutes per IP | `429 Too Many Requests` + `Retry-After` |
| Storage Flooding | Global Invoice Ceiling | `INVOICE_CEILING` (default: 5,000) | `503 Service Unavailable` |
| Wallet Hoarding | Per-Wallet Pending Cap | Max 25 active `PENDING` invoices per seller wallet | `429 Too Many Requests` (`PENDING_INVOICE_LIMIT_EXCEEDED`) |
| Disposable Email Floods | Email Domain Filter | Blocks mailinator, tempmail, guerrillamail, 10minutemail, etc. | `400 Bad Request` (`DISPOSABLE_EMAIL_REJECTED`) |
| Email Spam Relay | Outbound Queue Cap | Max 3 email notifications per invoice | `400 Bad Request` (`EXCEEDED_INVOICE_EMAIL_LIMIT`) |
| Outbound Wallet Email Cap | Wallet Email Rate Limiter | Max 10 emails per hour per seller wallet | `429 Too Many Requests` (`EMAIL_RATE_LIMIT_EXCEEDED`) |
| Unwanted Email Delivery | Recipient Blocklist | Opt-out / complaint blocklist | `400 Bad Request` (`INVALID_RECIPIENT_EMAIL`) |
| Provider Blacklisting | Circuit Breaker | Trips if bounce > 5% or complaints > 0.1% | Automatically pauses outbound delivery queue |
| Malicious Cancellation | Cryptographic Signature | Ed25519 seller signature over `cancel:<id>:<ts>` | `401 Unauthorized` |
| Request Flooding | Payload Body Cap | Hard limit: 16 kB per HTTP payload | `413 Payload Too Large` |

## 3. Email Delivery Safeguards

To prevent the demo from being flagged by email reputation systems (Spamhaus, Google Postmaster, Microsoft SNDS):
1. **Domain Verification**: Inbound recipient emails must conform to standard RFC format and cannot belong to known disposable email hosts.
2. **Per-Invoice Email Ceiling**: An invoice cannot be used to send more than 3 emails in total. This strictly bounds third-party notification spam even if an attacker generates multiple send requests.
3. **Blocklist / Opt-out Management**: Any recipient can be permanently blocked from demo emails via `emailAntiSpamService.blockEmail(recipient)`.
4. **Automated Breaker Trip**: If test emails bounce or trigger complaints exceeding thresholds, the email queue automatically switches to `PAUSED` mode to preserve delivery reputation.

## 4. Operational Monitoring

The health and status of abuse controls can be monitored via:
- Endpoint rate limiter metrics (Redis token bucket or in-memory store).
- Circuit breaker state: `emailAntiSpamService.getCircuitBreakerMetrics()`.
- Storage usage: `GET /api/invoices/stats`.
