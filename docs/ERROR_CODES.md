# Error Codes and Problem Details

Every API failure carries a stable machine `code`. Clients branch on `code`
(or the problem `type`), never on the human-readable message.

- **Registry:** `DOMAIN_ERROR_TAXONOMY` in `backend/src/errors/error-taxonomy.ts`
- **Lockfile:** `backend/tests/fixtures/error-codes.lock.json`
- **Enforced by:** `backend/tests/problem-details.test.ts`

## Two representations

The default is the legacy envelope described in `docs/API_CONTRACTS.md`. It is
unchanged, so existing clients need no migration.

A client opts in to [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
details by sending `Accept: application/problem+json`. Wildcards (`*/*`) do not
opt in. The response then has `Content-Type: application/problem+json`:

```json
{
  "type": "urn:inqutum:problem:memo-mismatch",
  "title": "Memo mismatch",
  "status": 400,
  "detail": "Memo INV-9 does not match INV-1",
  "instance": "/api/invoices/0f1c…/verify",
  "code": "MEMO_MISMATCH",
  "category": "SETTLEMENT",
  "retryable": false,
  "remediation": "Include the exact invoice memo in your transaction memo field before sending.",
  "correlationId": "3f8c1a20-…",
  "timestamp": "2026-10-16T09:14:02.118Z"
}
```

| Problem member | Legacy envelope field | Stability |
| --- | --- | --- |
| `type` | — (derived from `code`) | permanent |
| `code` | `code` | permanent |
| `status` | HTTP status | fixed per code |
| `category`, `retryable` | same | fixed per code |
| `title` | — (canonical message) | wording may improve |
| `detail` | `error` | request-specific, may change |
| `remediation` | `recoveryAction` | wording may improve |
| `instance` | — | request path, query string stripped |

The rewrite happens in one middleware, `problemDetailsNegotiation()`
(`backend/src/errors/problem-details.ts`), mounted before routes on both
servers. It applies to every failure envelope sent with a 4xx/5xx status:
`sendFailure`, `sendVerificationFailure`, the global error handler, the 404
handler and hand-written `res.status(...).json({ success: false, ... })`.
Error responses carry `Vary: Accept`.

## Stability rules

1. A code is never removed, renamed or reused. To retire one, keep it
   registered and mark it deprecated in the table below.
2. A code's status, category and retryability never change in place. If the
   semantics change, add a new code.
3. Adding a code requires, in the same change: a taxonomy entry, a lockfile
   entry, and a row in the table below. The test names whichever is missing.
4. The HTTP status a route sends a code with must equal the registered status
   (checked statically for literal `sendFailure` / `res.status().json` calls).

## Safe messages

- `NETWORK` and `INTERNAL` failures never echo the underlying error text,
  which may contain hosts, ports, SQL or provider responses. The canonical
  message is used instead. An explicit `AppError` keeps the message its
  thrower chose.
- In problem details, a 5xx with no registered code is reported as
  `INTERNAL_ERROR` with the canonical message; the original text stays in the
  server log, linked by `correlationId`.
- `instance` omits the query string so wallet keys and filters are not echoed.

## Edge cases and failure modes

| Situation | Behaviour |
| --- | --- |
| `Accept: application/problem+json;q=0` | Legacy envelope. |
| Accept lists both JSON types | Problem details (explicit opt-in wins). |
| Unregistered 4xx code | `type: about:blank`, `title` = HTTP reason phrase, original `code` kept. Fails CI if it comes from `src/`. |
| Raw (non-envelope) bodies: health, ready, metrics, downloads | Never rewritten. |
| Response already streaming (`res.send`/`res.write`) | Not rewritten; only `res.json` is intercepted. |
| Middleware throws | It only rewrites the object passed to `res.json`; pure, no I/O. |

## Rollback and recovery

- **Disable problem details:** remove `app.use(problemDetailsNegotiation())`
  from `server.ts` / `server-mvp.ts`. Clients fall back to the legacy envelope
  they already understand; no data or schema change is involved.
- **A client breaks on a new code:** codes are additive. Clients must treat an
  unknown code by `category` and `retryable`. Do not delete the code; fix the
  client or map it in the client.
- **Lockfile test fails after a refactor:** restore the original status,
  category or retryability. Only edit the lockfile when adding a new code.
- **Debugging a 5xx:** quote `correlationId`; the full error is in the server
  log under that id.

## Registered codes

| Code | Status | Category | Retryable | Message | Remediation |
| --- | --- | --- | --- | --- | --- |
| `MISSING_TX_HASH` | 400 | SETTLEMENT | no | Transaction hash is required | Provide a 64-character transaction hash from your Stellar wallet after submitting payment. |
| `INVALID_TX_HASH` | 400 | SETTLEMENT | no | Transaction hash must be 64 hexadecimal characters | Verify that the transaction hash contains exactly 64 hexadecimal characters. |
| `INVALID_PAYER_NAME` | 400 | VALIDATION | no | Payer name must be text | Enter a valid text string for the payer name or leave it empty. |
| `INVALID_PAYER_EMAIL` | 400 | VALIDATION | no | Payer email is invalid | Enter a valid email address (e.g. name@domain.com) or leave it empty. |
| `PAYER_INFO_TOO_LONG` | 400 | VALIDATION | no | Payer information is too long | Shorten payer name and email to under 255 characters. |
| `INVOICE_ALREADY_PAID` | 400 | LIFECYCLE | no | Invoice has already been paid | This invoice is already settled. You can download or email your quittance proof. |
| `INVOICE_EXPIRED` | 400 | LIFECYCLE | no | Invoice has expired and can no longer accept payment | The payment window has elapsed. Contact the seller to issue a new invoice. |
| `INVOICE_NOT_PENDING` | 400 | LIFECYCLE | no | Invoice is not pending | Only pending invoices can accept payment. Check invoice status on dashboard. |
| `TRANSACTION_NOT_FOUND` | 404 | NOT_FOUND | yes | Transaction not found on Stellar | Stellar ledger close takes ~5 seconds. Please wait a moment and retry verification. |
| `NO_PAYMENT_OPERATION` | 400 | SETTLEMENT | no | No payment operation found in transaction | Ensure your transaction contains a direct payment operation to the seller address. |
| `MEMO_MISMATCH` | 400 | SETTLEMENT | no | Memo mismatch | Include the exact invoice memo in your transaction memo field before sending. |
| `DESTINATION_MISMATCH` | 400 | SETTLEMENT | no | Payment destination mismatch | Send funds directly to the seller public key specified in the invoice. |
| `AMOUNT_MISMATCH` | 400 | SETTLEMENT | no | Amount mismatch | Send the exact invoice amount (matched at Stellar 7-decimal stroop precision). |
| `ASSET_MISMATCH` | 400 | SETTLEMENT | no | Asset mismatch | Pay with the designated asset. For non-native tokens, verify both asset code and issuer. |
| `NETWORK_MISMATCH` | 400 | SETTLEMENT | no | Transaction is on a different Stellar network | Switch your Freighter wallet to the matching Stellar network (Testnet or Public). |
| `VALIDATION_FAILED` | 400 | VALIDATION | no | Invalid input provided | Review the input parameters, ensuring valid numbers, addresses, and formats. |
| `SELLER_REQUIRED` | 400 | AUTHORIZATION | no | sellerPublicKey query parameter is required | Connect your Freighter wallet to supply the seller public key. |
| `UNAUTHORIZED_SELLER` | 403 | AUTHORIZATION | no | You are not authorized to modify this invoice | Connect the Freighter wallet that created this invoice. |
| `INVOICE_NOT_FOUND` | 404 | NOT_FOUND | no | Invoice not found | Check the invoice ID in the URL and ensure it has not been deleted. |
| `INVOICE_CANNOT_CANCEL` | 400 | LIFECYCLE | no | Only pending invoices can be cancelled | Invoices that are already paid or expired cannot be cancelled. |
| `CORS_ORIGIN_DENIED` | 403 | AUTHORIZATION | no | Origin is not allowed by Quittance CORS policy | Configure the frontend origin in FRONTEND_URL environment variables. |
| `HORIZON_UNAVAILABLE` | 503 | NETWORK | yes | Stellar Horizon is temporarily unreachable | Stellar network is experiencing a transient delay. Please retry in a few seconds. |
| `RATE_LIMITED` | 429 | RATE_LIMIT | yes | Too many requests. Please slow down. | Wait a few seconds before retrying the operation. |
| `CONFLICT` | 409 | LIFECYCLE | yes | Invoice was modified by another session. Please refresh and try again. | Refresh the invoice to get the latest version, then retry the operation. |
| `NOT_FOUND` | 404 | NOT_FOUND | no | Endpoint not found | Check the request method and path against docs/API_CONTRACTS.md. |
| `INVALID_STATUS` | 400 | VALIDATION | no | Unknown status filter | Use one of the status values listed in the error message. |
| `INVALID_CURSOR` | 400 | VALIDATION | no | Pagination cursor is not valid | Drop the cursor parameter and restart from the first page. |
| `INVOICE_NOT_PAID` | 400 | LIFECYCLE | no | This action is only available for PAID invoices | Wait until payment is verified, or use the payment_request template instead. |
| `RECIPIENT_EMAIL_REQUIRED` | 400 | VALIDATION | no | Recipient email address is required | Pass recipientEmail in the request body or set a customer email on the invoice. |
| `RECIPIENT_REQUIRED` | 400 | VALIDATION | no | recipient must be a valid Stellar public key | Pass the recipient wallet public key (G…, 56 characters). |
| `NOTIFICATION_NOT_FOUND` | 404 | NOT_FOUND | no | Notification not found | Refresh the notification list; the item may belong to another recipient. |
| `INVALID_EXPORT_REQUEST` | 400 | VALIDATION | no | Export request is not valid | Fix the fields named in the error message and resubmit the export. |
| `REQUESTER_REQUIRED` | 400 | VALIDATION | no | requester must be a valid Stellar public key | Use the downloadPath returned when the export was created; it carries the requester. |
| `EXPORT_FORBIDDEN` | 403 | AUTHORIZATION | no | You are not allowed to export these records | Export only invoices owned by the connected wallet. |
| `EXPORT_NOT_FOUND` | 404 | NOT_FOUND | no | Export not found | Generate a new export; export ids are only valid for the requester that created them. |
| `EXPORT_EXPIRED` | 410 | LIFECYCLE | no | This export has expired and was deleted | Generate a new export. |
| `EXPORT_FAILED` | 500 | INTERNAL | yes | Failed to generate export | Retry the export. If it keeps failing, contact support with the correlation ID. |
| `EMAIL_REQUEST_INVALID` | 400 | VALIDATION | no | Invalid email request | Check the request body against the /api/email/send contract. |
| `EMAIL_INVALID_RECIPIENT` | 400 | VALIDATION | no | Recipient is not a valid email address | Check the recipient address and try again. |
| `EMAIL_AUTH_FAILED` | 502 | NETWORK | no | The email provider rejected our credentials | The email provider rejected our credentials. A maintainer must fix the provider API key or SMTP username. |
| `EMAIL_QUOTA_EXCEEDED` | 429 | RATE_LIMIT | yes | The email provider is rate limiting this deployment | The email provider is rate limiting or out of quota. Try again later or upgrade the sending plan. |
| `EMAIL_TRANSIENT_FAILURE` | 503 | NETWORK | yes | The email provider is temporarily unreachable | The email provider is temporarily unreachable. Try again in a few minutes. |
| `EMAIL_NOT_CONFIGURED` | 503 | NETWORK | no | Email delivery is not configured | Email delivery is not configured for this deployment. See docs/EMAIL_DELIVERY.md. |
| `EMAIL_FAILED` | 502 | NETWORK | no | Email delivery failed | The email provider rejected this message. Check the address and content, then try again. |
| `EMAIL_WEBHOOK_INVALID` | 400 | VALIDATION | no | Invalid webhook payload | Provider callbacks must carry messageId and an event of bounce, complaint or delivered. |
| `EMAIL_DELIVERY_NOT_FOUND` | 404 | NOT_FOUND | no | No delivery matches that message id | Confirm the provider message id; callbacks for unknown messages are ignored. |
| `MALFORMED_WEBHOOK` | 400 | VALIDATION | no | Missing required webhook headers | Send X-Webhook-Signature, X-Webhook-Timestamp and X-Webhook-Event-Id. |
| `STALE_TIMESTAMP` | 408 | VALIDATION | no | Webhook timestamp is outside the allowed window | Re-sign the event with a fresh timestamp and check the sender clock. |
| `INVALID_SIGNATURE` | 401 | AUTHORIZATION | no | Webhook signature verification failed | Sign the raw request body with the shared WEBHOOK_SIGNING_SECRET. |
| `DUPLICATE_EVENT` | 409 | LIFECYCLE | no | Webhook event has already been processed | No action needed; the event was already applied. Do not retry it. |
| `UNAUTHORIZED` | 401 | AUTHORIZATION | no | Invalid or missing admin token | Send Authorization: Bearer <JOBS_ADMIN_TOKEN>. |
| `JOBS_ADMIN_DISABLED` | 403 | AUTHORIZATION | no | Job inspection is not enabled | Set JOBS_ADMIN_TOKEN on the deployment to enable the admin surface. |
| `JOB_NOT_FOUND` | 404 | NOT_FOUND | no | Job not found | List jobs first; completed jobs may have been pruned. |
| `JOB_NOT_DEAD` | 409 | LIFECYCLE | no | Only dead-lettered jobs can be retried | Wait for the job to finish or dead-letter before retrying it. |
| `TARGET_INVALID` | 400 | VALIDATION | no | targetId must be a valid Stellar public key | Pass the target wallet public key (G…, 56 characters). |
| `IMPERSONATION_REJECTED` | 400 | AUTHORIZATION | no | Impersonation session rejected | Supply a reason, an allowed permission set and a duration within policy limits. |
| `SESSION_NOT_FOUND` | 404 | NOT_FOUND | no | No active session with that id for this maintainer | The session may have already expired or been ended. |
| `INTERNAL_ERROR` | 500 | INTERNAL | yes | An internal server error occurred | Please retry your request. If the problem persists, contact support with the correlation ID. |
