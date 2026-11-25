# Error Codes & Remediation Hints

Every failure the API returns carries a **stable error code** plus the metadata
clients need to react: `category`, `retryable`, a one-line `recoveryAction`, and
— since contract `1.1.0` — an ordered `remediation` checklist. This document is
the published catalog; `backend/src/errors/error-taxonomy.ts`
(`DOMAIN_ERROR_TAXONOMY`) is the implementation, and the tests listed at the
bottom keep the two in lockstep.

- **Issue:** #303 — implement stable error codes with documented remediation hints
- **Authority:** `DOMAIN_ERROR_TAXONOMY` in `backend/src/errors/error-taxonomy.ts`
- **Envelope:** `ApiFailure` in `backend/src/types/api.ts` (shared by
  `server.ts` and `server-mvp.ts`), documented in [API_CONTRACTS.md](API_CONTRACTS.md)

## Failure envelope

```json
{
  "success": false,
  "error": "Memo mismatch",
  "code": "MEMO_MISMATCH",
  "category": "SETTLEMENT",
  "retryable": false,
  "recoveryAction": "Include the exact invoice memo in your transaction memo field before sending.",
  "remediation": [
    "Copy the exact memo shown on the invoice into your wallet before sending.",
    "If payment already went out, contact the seller — the hash alone does not match this invoice."
  ],
  "correlationId": "3f8c1a20-…",
  "timestamp": "2026-10-18T12:00:00.000Z"
}
```

How to read the metadata:

| Field | Meaning |
| --- | --- |
| `code` | Stable, machine-readable identifier. Codes are append-only: a code is never repurposed or renamed. |
| `category` | Coarse class (`VALIDATION`, `AUTHORIZATION`, `SETTLEMENT`, `LIFECYCLE`, `NOT_FOUND`, `NETWORK`, `RATE_LIMIT`, `INTERNAL`) for routing and alerting. |
| `retryable` | `true` when retrying the *same* request can succeed without changes. |
| `recoveryAction` | One-sentence guidance — what to do, in a single line. |
| `remediation` | Ordered, concrete steps for the code. Each entry is one action a user or operator can perform; clients can render it as a checklist. Optional key: pre-`1.1.0` clients never see it, post-`1.1.0` clients must tolerate it being absent (see migration below). |

`recoveryAction` and `remediation` are both derived from the same catalog entry,
so they never contradict each other; `remediation` is simply finer-grained.

## Catalog

Generated from `DOMAIN_ERROR_TAXONOMY` by `npm run errors:catalog`
(`backend/scripts/generate-error-catalog.ts`). Editing a code without
regenerating fails `backend/tests/error-remediation.test.ts`.

<!-- BEGIN GENERATED CATALOG: run `npm run errors:catalog` after editing DOMAIN_ERROR_TAXONOMY -->

### Settlement & verification (15 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `MISSING_TX_HASH` | 400 | SETTLEMENT | no | Provide a 64-character transaction hash from your Stellar wallet after submitting payment. | 1. Open your Stellar wallet and copy the 64-character hash of the payment transaction.<br>2. Paste it into the transaction hash field and submit the form again. | |
| `INVALID_TX_HASH` | 400 | SETTLEMENT | no | Verify that the transaction hash contains exactly 64 hexadecimal characters. | 1. Remove spaces, dashes, or any 0x prefix from the pasted value.<br>2. Copy the hash again from your wallet’s transaction detail view; it must be exactly 64 hex characters. | |
| `INVALID_PAYER_NAME` | 400 | VALIDATION | no | Enter a valid text string for the payer name or leave it empty. | 1. Replace the payer name with plain text, or clear the field if it is optional.<br>2. Resubmit the payment form. | |
| `INVALID_PAYER_EMAIL` | 400 | VALIDATION | no | Enter a valid email address (e.g. name@domain.com) or leave it empty. | 1. Correct the address so it matches the format name@domain.com.<br>2. Leave the field empty if no receipt is needed, then resubmit. | |
| `PAYER_INFO_TOO_LONG` | 400 | VALIDATION | no | Shorten payer name and email to under 255 characters. | 1. Shorten the payer name and email so each is under 255 characters.<br>2. Resubmit the form. | |
| `INVOICE_ALREADY_PAID` | 400 | LIFECYCLE | no | This invoice is already settled. You can download or email your quittance proof. | 1. Download the quittance proof from the invoice page, or email it from the receipt action.<br>2. Ask the seller for a new invoice if another payment is genuinely required. | |
| `INVOICE_EXPIRED` | 400 | LIFECYCLE | no | The payment window has elapsed. Contact the seller to issue a new invoice. | 1. Contact the seller and ask for a new invoice with a fresh expiry.<br>2. Do not send payment against the expired memo; the seller will reject it. | |
| `INVOICE_NOT_PENDING` | 400 | LIFECYCLE | no | Only pending invoices can accept payment. Check invoice status on dashboard. | 1. Refresh the invoice page to see its current status.<br>2. Ask the seller for a new invoice if this one is no longer PENDING. | |
| `TRANSACTION_NOT_FOUND` | 404 | NOT_FOUND | yes | Stellar ledger close takes ~5 seconds. Please wait a moment and retry verification. | 1. Wait about 10 seconds for the ledger to close, then retry verification.<br>2. If it still fails, confirm the hash in a Stellar explorer for the invoice network before retrying. | |
| `NO_PAYMENT_OPERATION` | 400 | SETTLEMENT | no | Ensure your transaction contains a direct payment operation to the seller address. | 1. Open the transaction in a Stellar explorer and confirm it contains a payment operation to the seller.<br>2. Resubmit with the hash of the payment that was actually sent. | |
| `MEMO_MISMATCH` | 400 | SETTLEMENT | no | Include the exact invoice memo in your transaction memo field before sending. | 1. Copy the exact memo shown on the invoice into your wallet before sending.<br>2. If payment already went out, contact the seller — the hash alone does not match this invoice. | |
| `DESTINATION_MISMATCH` | 400 | SETTLEMENT | no | Send funds directly to the seller public key specified in the invoice. | 1. Compare the payment destination with the seller public key on the invoice.<br>2. Send funds to the seller public key from the invoice, then resubmit the new transaction hash. | |
| `AMOUNT_MISMATCH` | 400 | SETTLEMENT | no | Send the exact invoice amount (matched at Stellar 7-decimal stroop precision). | 1. Recalculate the amount due, including every decimal place shown on the invoice.<br>2. Resend the exact amount (matching at 7-decimal stroop precision) and verify the new hash. | |
| `ASSET_MISMATCH` | 400 | SETTLEMENT | no | Pay with the designated asset. For non-native tokens, verify both asset code and issuer. | 1. Check the asset code and issuer on the invoice.<br>2. Select the matching asset in your wallet (both code and issuer must match) and repay. | |
| `NETWORK_MISMATCH` | 400 | SETTLEMENT | no | Switch your Freighter wallet to the matching Stellar network (Testnet or Public). | 1. Open Freighter settings and select the network named on the invoice (Testnet or Public).<br>2. Resubmit the same transaction hash. | |

### General API domain errors (12 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `VALIDATION_FAILED` | 400 | VALIDATION | no | Review the input parameters, ensuring valid numbers, addresses, and formats. | 1. Read the field named in the error message and correct its value.<br>2. Resubmit the request; if the message stays unclear, report the correlationId. | |
| `SELLER_REQUIRED` | 400 | AUTHORIZATION | no | Connect your Freighter wallet to supply the seller public key. | 1. Add ?sellerPublicKey=<G...> to the request, or connect Freighter so the UI supplies it.<br>2. Retry once the seller public key is present. | |
| `INVALID_STATUS` | 400 | VALIDATION | no | Filter by PENDING, PAID, EXPIRED or CANCELLED, or omit status to list every invoice. | 1. Use one of PENDING, PAID, EXPIRED, CANCELLED as the status value.<br>2. Omit the status parameter entirely to list every invoice. | |
| `INVALID_CURSOR` | 400 | VALIDATION | no | Drop the cursor and request the first page again. | 1. Remove the cursor parameter and request the first page.<br>2. Use the nextCursor value from the previous response instead of hand-editing it. | |
| `UNAUTHORIZED_SELLER` | 403 | AUTHORIZATION | no | Connect the Freighter wallet that created this invoice. | 1. Switch Freighter to the wallet that created the invoice.<br>2. Retry the action after the wallet is connected. | |
| `INVOICE_NOT_FOUND` | 404 | NOT_FOUND | no | Check the invoice ID in the URL and ensure it has not been deleted. | 1. Check the invoice id in the URL for typos.<br>2. List your invoices from the dashboard to confirm it still exists. | |
| `INVOICE_CANNOT_CANCEL` | 400 | LIFECYCLE | no | Invoices that are already paid or expired cannot be cancelled. | 1. Refresh the invoice to confirm its current status.<br>2. Take no further action if it is PAID or EXPIRED; only PENDING invoices can be cancelled. | |
| `CORS_ORIGIN_DENIED` | 403 | AUTHORIZATION | no | Configure the frontend origin in FRONTEND_URL environment variables. | 1. Add the frontend origin to the FRONTEND_URL environment variable.<br>2. Restart the backend and retry the request from the allowed origin. | |
| `HORIZON_UNAVAILABLE` | 503 | NETWORK | yes | Stellar network is experiencing a transient delay. Please retry in a few seconds. | 1. Retry the request after a few seconds; Horizon outages are transient.<br>2. Check the Stellar status page before retrying again if the outage lasts. | |
| `RATE_LIMITED` | 429 | RATE_LIMIT | yes | Wait a few seconds before retrying the operation. | 1. Wait for any Retry-After window before sending the next request.<br>2. Add exponential backoff to your client and reduce request frequency. | |
| `CONFLICT` | 409 | LIFECYCLE | yes | Refresh the invoice to get the latest version, then retry the operation. | 1. Reload the invoice so you are working against its latest version.<br>2. Re-apply your change and resubmit. | |
| `INTERNAL_ERROR` | 500 | INTERNAL | yes | Please retry your request. If the problem persists, contact support with the correlation ID. | 1. Retry the request once; transient failures often clear up.<br>2. If the failure repeats, report the correlationId to support so the logs can be traced. | |

### Global & transport-level (2 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `NOT_FOUND` | 404 | NOT_FOUND | no | Check the HTTP method and path against docs/API_CONTRACTS.md. | 1. Compare the method and path with the route table in docs/API_CONTRACTS.md.<br>2. Remove trailing segments or version prefixes the client may have added. | |
| `INVALID_FILTER` | 400 | VALIDATION | no | Fix the filter value or omit it to list every item. | 1. Remove the rejected filter parameter and retry.<br>2. Compare the filter with the values documented for this endpoint. | |

### Authorization & admin surface (4 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | AUTHORIZATION | no | Send Authorization: Bearer <JOBS_ADMIN_TOKEN> from the server environment. | 1. Copy the current JOBS_ADMIN_TOKEN value from the deployment environment.<br>2. Send it as an Authorization: Bearer header and retry. | |
| `JOBS_ADMIN_DISABLED` | 403 | AUTHORIZATION | no | Set JOBS_ADMIN_TOKEN in the environment to enable job inspection. | 1. Set JOBS_ADMIN_TOKEN and restart the server to enable the job surface.<br>2. Until then, read job state from the application logs. | |
| `APPROVALS_DISABLED` | 403 | AUTHORIZATION | no | Set MAINTAINER_INTENT_SECRET to enable high-impact actions. | 1. Set MAINTAINER_INTENT_SECRET (32+ characters) and restart the server.<br>2. Retry the action; it will now require the maintainer intent flow. | |
| `CAPABILITIES_DISABLED` | 403 | AUTHORIZATION | no | Set CAPABILITY_TOKEN_SECRET (32+ characters) to enable sensitive admin actions. | 1. Set CAPABILITY_TOKEN_SECRET to a random value of at least 32 characters.<br>2. Restart the server, then request a capability token before retrying. | |

### Sessions & impersonation (2 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `SESSION_NOT_FOUND` | 404 | AUTHORIZATION | no | Start a new impersonation session; sessions do not survive restarts. | 1. Request a new impersonation session and use the id it returns.<br>2. Check that the session id was copied without truncation. | |
| `IMPERSONATION_REJECTED` | 400 | AUTHORIZATION | no | Correct the rejected field (reason or target) and start the session again. | 1. Read the message to learn which field was rejected and correct it.<br>2. Start a new session with the corrected request. | |

### Ops tooling (replay, projector, repair, receipts) (9 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `REPLAY_REFUSED` | 409 | LIFECYCLE | no | Read the reasons in the response, repair the listed blockers, then replay again. | 1. Inspect the reasons array returned with the failure.<br>2. Repair each listed blocker (for example stale checkpoints) and request the replay again. | |
| `REPLAY_IN_PROGRESS` | 409 | LIFECYCLE | yes | Wait for the running replay to finish, then retry. | 1. Poll the replay status until the current run settles.<br>2. Retry the request once it is no longer running. | |
| `NOTHING_TO_ROLL_BACK` | 409 | LIFECYCLE | no | Nothing was applied, so no rollback is needed; verify the current version first. | 1. Read the current configuration version to confirm no change landed.<br>2. Stop the rollback flow — there is no earlier state to restore. | |
| `INVALID_PROJECTOR_VERSION` | 400 | VALIDATION | no | Pass an integer projectorVersion from the supported list. | 1. Request the supported projector versions from the ops surface.<br>2. Resend the request with a supported integer version. | |
| `DRY_RUN_UNAVAILABLE` | 503 | INTERNAL | no | Deploy storage that supports enumeration, or proceed without the impact preview. | 1. Run the action without the dry-run impact block, or<br>2. Restore the storage adapter capability and retry the dry run. | |
| `RECEIPT_NOT_FOUND` | 404 | NOT_FOUND | no | Receipts exist only after a recorded maintainer action; check the receipt id. | 1. Verify the receipt id against the audit log.<br>2. List recent audit events to find the correct receipt id. | |
| `REPAIR_JOB_NOT_FOUND` | 404 | NOT_FOUND | no | List repair jobs for current ids; finished jobs are pruned. | 1. Call GET /api/ops/repair-records/jobs for live ids.<br>2. Start a new repair job if the old one was pruned. | |
| `REFERENCE_NOT_FOUND` | 404 | NOT_FOUND | no | Re-run the external reference verification to create a record. | 1. Submit the verification request again so a record is stored.<br>2. Check the reference id for typos. | |
| `TARGET_INVALID` | 400 | VALIDATION | no | Supply a 56-character G... public key as targetId. | 1. Copy the target public key from the invoice or account view.<br>2. Resend the request with the corrected targetId. | |

### Partial-failure retry outcomes (4 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `USER_ACTION_REQUIRED` | 422 | LIFECYCLE | no | Complete the user action named in the message, then retry. | 1. Read the message for the required action (for example re-authenticate or provide input).<br>2. Complete the action and retry the operation. | |
| `RETRY_IN_PROGRESS` | 409 | LIFECYCLE | yes | Wait for the running retry to finish before requesting another. | 1. Poll the job record until its state settles.<br>2. Retry the request afterward; duplicate retries are refused. | |
| `NOT_RETRYABLE_STATE` | 409 | LIFECYCLE | no | Let the scheduler handle it, or dead-letter the job first. | 1. Check the job status shown in the message.<br>2. Wait for automatic retry, or move the job to the dead-letter state for a manual retry. | |
| `NOT_FAILED` | 409 | LIFECYCLE | no | Only failed or dead-lettered jobs can be retried. | 1. Refresh the job state to confirm it failed.<br>2. Target a job that is failed or dead-lettered. | |

### Job inspection & queue (3 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `JOBS_UNAVAILABLE` | 503 | INTERNAL | no | Configure the job store (or use the server variant that includes it) before this endpoint. | 1. Provision the job store this deployment expects, or call the server variant that includes it.<br>2. Retry after the server reports the job store as available. | |
| `JOB_NOT_FOUND` | 404 | NOT_FOUND | no | List jobs to get a current id; ids rotate when the queue is pruned. | 1. Call GET /api/jobs for live ids.<br>2. Check the id for truncation before retrying. | |
| `JOB_NOT_DEAD` | 409 | LIFECYCLE | no | Wait for the retry budget to exhaust, or dead-letter the job first. | 1. Check the job status; it is not dead yet.<br>2. Wait for automatic retries to exhaust, then retry this action. | |

### Invoice & notification paths (6 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `INVOICE_NOT_PAID` | 400 | LIFECYCLE | no | Complete the payment first, then request the proof. | 1. Open the payment page and submit payment for this invoice.<br>2. Request the proof again once the invoice status is PAID. | |
| `IDEMPOTENCY_KEY_REUSED` | 422 | VALIDATION | no | Use a fresh Idempotency-Key for a new request, or resend the original request to get its result. | 1. Generate a new random key for this new operation.<br>2. To read the previous outcome, resend the original request with its original key. | |
| `INVALID_IDEMPOTENCY_KEY` | 400 | VALIDATION | no | Send a key between 1 and 200 characters, or omit the header. | 1. Trim or regenerate the key so it is 1-200 characters.<br>2. Omit the header entirely if retry deduplication is not needed. | |
| `RECIPIENT_EMAIL_REQUIRED` | 400 | VALIDATION | no | Set customerEmail on the invoice or pass recipientEmail in the request. | 1. Add recipientEmail to the request body, or<br>2. Set the customer email on the invoice, then retry. | |
| `NOTIFICATION_NOT_FOUND` | 404 | NOT_FOUND | no | Reload the notification list; this id may have been pruned. | 1. Refresh the notification list for current ids.<br>2. Mark-read only ids returned by the list endpoint. | |
| `RECIPIENT_REQUIRED` | 400 | VALIDATION | no | Pass a 56-character G... public key as the recipient parameter. | 1. Copy the recipient public key from the account view.<br>2. Resend the request with a valid recipient query/body parameter. | |

### Email delivery (12 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `EMAIL_AUTH_FAILED` | 502 | AUTHORIZATION | no | The email provider rejected our credentials. A maintainer must fix the provider API key or SMTP username. | 1. Rotate the provider API key or SMTP password in the deployment secrets.<br>2. Restart the server and send a test email to confirm the fix. | |
| `EMAIL_QUOTA_EXCEEDED` | 429 | RATE_LIMIT | yes | The email provider is rate limiting or out of quota. Try again later or upgrade the sending plan. | 1. Wait for the provider window to reset (honour Retry-After when present).<br>2. Retry the send, or raise the provider plan if this recurs. | |
| `EMAIL_TRANSIENT_FAILURE` | 503 | NETWORK | yes | The email provider is temporarily unreachable. Try again in a few minutes. | 1. Wait a few minutes for the provider to recover.<br>2. Retry with the same idempotency key so the message cannot duplicate. | |
| `EMAIL_INVALID_RECIPIENT` | 400 | VALIDATION | no | Check the recipient address and try again. | 1. Correct the address so it is a plain name@domain.com value.<br>2. Resend the message. | |
| `EMAIL_NOT_CONFIGURED` | 503 | INTERNAL | no | Email delivery is not configured for this deployment. See docs/EMAIL_DELIVERY.md. | 1. Configure the provider credentials described in docs/EMAIL_DELIVERY.md.<br>2. Restart the server, then retry the send. | |
| `EMAIL_SEND_IN_PROGRESS` | 409 | LIFECYCLE | yes | A send with this idempotency key is still running. Retry in a moment to get its result. | 1. Wait a moment for the in-flight send to settle.<br>2. Retry with the same idempotency key to read its result. | |
| `EMAIL_OUTCOME_IN_DOUBT` | 409 | LIFECYCLE | no | A previous send stopped before its outcome was recorded. Check the provider log, then resolve the checkpoint (docs/RECOVERY_CHECKPOINTS.md). | 1. Search the provider logs for the message id to learn whether it was delivered.<br>2. Resolve the checkpoint per docs/RECOVERY_CHECKPOINTS.md, then resend only if it was not delivered. | |
| `EMAIL_IDEMPOTENCY_KEY_REUSED` | 422 | VALIDATION | no | This idempotency key was already used for a different email. Use a new key for a new message. | 1. Generate a new key for the new message.<br>2. Resend the original request instead if you wanted the original result. | |
| `EMAIL_FAILED` | 502 | NETWORK | no | The email provider rejected this message. Check the address and content, then try again. | 1. Read the provider response for the rejection reason (address, content, attachments).<br>2. Fix the message and send again with a new idempotency key. | |
| `EMAIL_REQUEST_INVALID` | 400 | VALIDATION | no | Correct the invalid field described in the message and resend the email request. | 1. Validate the payload against the /email/send schema in docs/API_CONTRACTS.md.<br>2. Resend with the corrected fields. | |
| `EMAIL_DELIVERY_NOT_FOUND` | 404 | NOT_FOUND | no | Check the messageId; only provider-confirmed ids resolve. | 1. Copy the messageId returned by the original send.<br>2. List deliveries via GET /api/email/deliveries to find the id. | |
| `EMAIL_WEBHOOK_INVALID` | 400 | VALIDATION | no | Send messageId, event (bounce\|complaint\|delivered), and an optional reason. | 1. Fix the payload so event is one of bounce, complaint, delivered.<br>2. Resend the provider callback. | |

### Exports (10 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `EXPORT_EXPIRED` | 410 | LIFECYCLE | no | Generate a new export; expired artifacts are pruned. | 1. Request a new export with the same filters.<br>2. Download exports promptly; artifacts are pruned after their TTL. | |
| `EXPORT_FAILED` | 500 | INTERNAL | yes | Retry the export; if it fails again, narrow the filters. | 1. Retry the same request once.<br>2. Narrow the filter window if the retry fails, and report the correlationId. | |
| `EXPORT_FORBIDDEN` | 403 | AUTHORIZATION | no | Request exports only for keys you control; pass a requester you own. | 1. Sign the request with the requester public key that owns the data.<br>2. Ask a maintainer to grant access to the requested range. | |
| `EXPORT_NOT_FOUND` | 404 | NOT_FOUND | no | Check the export id; expired exports are deleted. | 1. List exports to find a live id.<br>2. Create a new export if the old one expired. | |
| `EXPORT_TIMED_OUT` | 503 | NETWORK | yes | Narrow the filters and try again. | 1. Reduce the date range or row count of the export.<br>2. Retry with the narrower filters. | |
| `INVALID_EXPORT_FIELDS` | 400 | VALIDATION | no | Request only field names listed in docs/EXPORTS.md. | 1. Remove unknown field names from the fields list.<br>2. Send between 1 and 32 field names, or omit fields for the default set. | |
| `EXPORT_FIELD_FORBIDDEN` | 403 | AUTHORIZATION | no | Drop the fields listed in deniedFields and request the export again. | 1. Personal fields (names, emails) are never exportable.<br>2. Counterparty fields need a grant the public export route does not give. | |
| `EXPORT_IDEMPOTENCY_CONFLICT` | 409 | VALIDATION | no | Use a new Idempotency-Key for a different export request. | 1. Reuse a key only to retry the exact same export request.<br>2. Generate a fresh key when changing format, filters or fields. | |
| `INVALID_EXPORT_REQUEST` | 400 | VALIDATION | no | Fix the request fields listed in the message. | 1. Read the field errors joined in the message body.<br>2. Resend a corrected export request. | |
| `REQUESTER_REQUIRED` | 400 | VALIDATION | no | Add ?requester=<public key> so the export can be scoped to you. | 1. Append the requester query parameter with your public key.<br>2. Resend the request. | |

### Inbound webhooks (10 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `MALFORMED_WEBHOOK` | 400 | VALIDATION | no | Send X-Webhook-Signature, X-Webhook-Timestamp and X-Webhook-Event-Id headers. | 1. Add all three webhook headers to the request.<br>2. Resend the event. | |
| `STALE_TIMESTAMP` | 408 | VALIDATION | yes | Sign the payload again with the current time and retry. | 1. Regenerate X-Webhook-Timestamp with the current epoch seconds.<br>2. Re-sign the body with the fresh timestamp and resend. | |
| `INVALID_SIGNATURE` | 401 | AUTHORIZATION | no | Sign the raw body with the shared secret using the documented scheme. | 1. Recompute the signature over the exact raw body with WEBHOOK_SIGNING_SECRET.<br>2. Confirm the header format sha256=<hex>, then resend. | |
| `DUPLICATE_EVENT` | 409 | LIFECYCLE | no | This event id was already processed; use a new event id for a new event. | 1. Treat the event as successfully handled.<br>2. Generate a fresh X-Webhook-Event-Id only for genuinely new events. | |
| `WEBHOOK_EVENT_ID_INVALID` | 400 | VALIDATION | no | Provide a non-empty provider name and an event ID of at most 255 characters. | 1. Ensure the provider name and event ID headers/fields are present and non-empty.<br>2. Truncate or reformat the event ID to stay within 255 characters, then resend. | |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | AUTHORIZATION | no | Verify that the webhook signature matches the shared secret and raw request body. | 1. Check that the webhook signing secret configured on the sender matches the receiver.<br>2. Compute the HMAC signature over the exact unmodified raw payload bytes before sending. | |
| `WEBHOOK_DEDUPE_STORE_UNAVAILABLE` | 503 | INTERNAL | yes | The idempotency storage layer is unavailable. Retry the delivery with exponential backoff. | 1. Retry the webhook delivery after a short delay (e.g. 1-5 seconds) with backoff.<br>2. Check the health and network connectivity of the underlying persistence or Redis store. | |
| `WEBHOOK_EVENT_IN_PROGRESS` | 409 | LIFECYCLE | yes | Another worker is currently processing this event. Retry shortly to receive the completed result. | 1. Wait 1-2 seconds and retry with the same event ID to receive the completed response.<br>2. Ensure provider delivery retry intervals allow preceding attempts to finish processing. | |
| `WEBHOOK_EVENT_ID_CONFLICT` | 422 | VALIDATION | no | Do not reuse an existing event ID with conflicting payload content. Use a new event ID for distinct events. | 1. Verify that distinct webhook events generate distinct, globally unique event IDs.<br>2. If modifying an existing event payload, assign a new event ID before sending. | |
| `WEBHOOK_EVENT_ID_EXPIRED` | 410 | LIFECYCLE | no | The retention window for this event ID has expired. Submit new events with fresh event IDs. | 1. Do not resend webhook events older than the 7-day retention TTL window.<br>2. Generate a new event ID if the event must be processed again. | |

### Capability tokens (9 codes)

| Code | HTTP | Category | Retryable | Recovery action | Remediation hints |
| --- | --- | --- | --- | --- | --- |
| `CAPABILITY_REQUEST_INVALID` | 400 | VALIDATION | no | Request the capability with a valid action, target, and TTL. | 1. Fix the invalid field in the capability request.<br>2. Request a new token and retry the action. | |
| `UNKNOWN_CAPABILITY_ACTION` | 400 | VALIDATION | no | Use an action name from the capability scope list in docs/CAPABILITY_TOKENS.md. | 1. Check the supported action names in docs/CAPABILITY_TOKENS.md.<br>2. Request a token scoped to the correct action. | |
| `CAPABILITY_REQUIRED` | 401 | AUTHORIZATION | no | Add the X-Capability-Token header from POST /api/ops/capabilities. | 1. Request a capability token for this action.<br>2. Send it in the X-Capability-Token header and retry. | |
| `CAPABILITY_INVALID` | 401 | AUTHORIZATION | no | Request a fresh capability token. | 1. Request a new token from POST /api/ops/capabilities.<br>2. Retry the action with the new token. | |
| `CAPABILITY_EXPIRED` | 401 | AUTHORIZATION | no | Tokens are short-lived; request a new one immediately before use. | 1. Request a new token right before performing the action.<br>2. Retry with the fresh token. | |
| `CAPABILITY_SCOPE_MISMATCH` | 403 | AUTHORIZATION | no | Request a token scoped to this action and target. | 1. Check the action and target your current token was issued for.<br>2. Request a token with the required scope, then retry. | |
| `CAPABILITY_IN_USE` | 409 | LIFECYCLE | yes | Wait for the in-flight action to finish; single-use tokens refuse concurrency. | 1. Wait for the original request that holds this token to complete.<br>2. Retry once it settles. | |
| `CAPABILITY_ALREADY_USED` | 409 | LIFECYCLE | no | Each token is single-use; request a new one for another action. | 1. Request a new capability token.<br>2. Retry with the new token. | |
| `CAPABILITY_LEDGER_FULL` | 503 | INTERNAL | yes | The token ledger is at capacity; retry shortly. | 1. Retry after a few seconds as in-flight tokens expire.<br>2. If it persists, raise the ledger capacity so reserved tokens can be tracked. | |

<!-- END GENERATED CATALOG -->

## Problem-details response redaction

Every free-text field emitted by `toProblemDetails` is passed through the
shared error-message redactor: `detail`, `recoveryAction`, each
`remediation` step, and validation `fieldErrors.message` / `fieldErrors.hint`.
This prevents credentials, Stellar secret seeds, and database URL passwords
from bypassing redaction through guidance or validation metadata. Validation
field names and machine-readable error codes remain unchanged; multiline
messages are reduced to their first line by the shared redaction helper.

This is a response-serialization hardening change only. It introduces no
database changes, new response keys, or client migration. Rolling back the
change restores the previous redaction behavior and does not require a data
migration; clients continue to receive the same Problem Details shape.

## Operational edge cases

**Horizon outage (`HORIZON_UNAVAILABLE`, 503, retryable).** Verification and
payment lookups fail fast while Stellar Horizon is unreachable. Guidance is in
the hints (retry after a few seconds); operators should confirm on the Stellar
status page before escalating. No data is written by a failed verification, so
retries are safe.

**Ledger lag (`TRANSACTION_NOT_FOUND`, 404, retryable).** A submitted payment is
not queryable for roughly one ledger close (~5 seconds). The code is retryable
by design: wait and retry verification rather than re-sending payment.

**Rate limits (`RATE_LIMITED` 429, `EMAIL_QUOTA_EXCEEDED` 429).** Both are
retryable and expect backoff — honour `Retry-After` when the server sends one.
`EMAIL_QUOTA_EXCEEDED` reflects the provider's quota, not the app's; escalating
means raising the provider plan, not the caller's frequency.

**Idempotency (`INVALID_IDEMPOTENCY_KEY` 400, `IDEMPOTENCY_KEY_REUSED` 422,
`EMAIL_IDEMPOTENCY_KEY_REUSED` 422).** Keys are bounded (1–200 characters) and
single-purpose: a key that was used for a different request cannot be replayed.
To read the previous outcome, resend the *original* request with its original
key; to start a new operation, generate a fresh key. `EMAIL_SEND_IN_PROGRESS`
(409, retryable) means a send with that key is still running — retry the same
request shortly to collect its result.

**Email outcome in doubt (`EMAIL_OUTCOME_IN_DOUBT`, 409, not retryable).** A
send stopped before its result was recorded. Check the provider logs for the
message id, then resolve the checkpoint per
[RECOVERY_CHECKPOINTS.md](RECOVERY_CHECKPOINTS.md); only resend if delivery is
not confirmed. See [EMAIL_DELIVERY.md](EMAIL_DELIVERY.md) for the provider
failure table.

**Webhook replay & clock skew (`DUPLICATE_EVENT` 409, `STALE_TIMESTAMP` 408).**
Replayed event ids are refused after the first successful verification — treat
`DUPLICATE_EVENT` as success. `STALE_TIMESTAMP` is retryable: re-sign the
payload with a fresh timestamp. Signature failures (`INVALID_SIGNATURE` 401)
are never retryable without re-signing.

**Capability tokens & sessions (`CAPABILITY_*`, `SESSION_NOT_FOUND`,
`IMPERSONATION_REJECTED`).** Capability tokens are short-lived and single-use
(`CAPABILITY_ALREADY_USED`, `CAPABILITY_IN_USE` — the latter is retryable once
the holder finishes). Request a token immediately before the action. Sessions
are in-memory: after a restart, start a new session instead of retrying with
the old id. `CAPABILITIES_DISABLED` / `APPROVALS_DISABLED` are deployment
configuration problems — see [CAPABILITY_TOKENS.md](CAPABILITY_TOKENS.md).

**Queue & job store (`JOBS_UNAVAILABLE` 503, `JOBS_ADMIN_DISABLED` 403,
`QUEUE`-related failures surfaced as job status).** Not-configured surfaces are
not retryable until an operator provisions them; `RETRY_IN_PROGRESS` /
`RETRY`-style refusals are the queue enforcing one-retry-at-a-time. See
[JOBS.md](JOBS.md).

**Unknown codes.** Clients must treat an unrecognized `code` as a generic
failure: show `error`, and only retry when `retryable === true` (or the HTTP
status is 408/429). New codes are appended over time; nothing forces a client
to know them all — `remediation` arrives with the failure precisely so clients
do not need a local copy of this document.

**Policy rejections are a sibling contract, not this one.** Policy, trend, and
simulation denials (`AMOUNT_TOO_LOW`, `ALLOW_LIST_VIOLATION`, …) return an
additional `explanation` block with its own `reasonCode` and ordered
`recoveryHints`, documented in
[REJECTION_EXPLANATIONS.md](REJECTION_EXPLANATIONS.md). Their hints satisfy the
same remediation intent through that contract; this catalog covers the shared
failure envelope.

## Recovery & rollback (contract 1.1.0)

The `remediation` key is **purely additive**:

- **Upgrade.** Servers may ship `remediation` at any time. Old clients ignore
  unknown JSON keys, so nothing breaks. New clients should render `remediation`
  when present and fall back to `recoveryAction` when it is absent (including
  when talking to a server that was rolled back to 1.0.0).
- **Rollback.** Reverting the server simply stops emitting `remediation`.
  Because clients are required to tolerate its absence, rollback needs no
  coordination and no data migration. `CONTRACT_VERSION` documents which
  behavior a given deployment speaks (1.1.0 with the key, 1.0.0 without it).
- **Catalog policy.** Entries are append-only. A code is never reused for a
  different meaning; deprecated codes stop being emitted but stay in the table
  with their last documented hints. Status/category/retryable for an existing
  code may only change together with a `CONTRACT_VERSION` bump and a note here.

## Enforcement

| Guard | What it proves |
| --- | --- |
| `backend/tests/error-remediation.test.ts` | Every catalog entry has non-empty remediation steps; every code emitted by routes, servers and webhook middleware is in the catalog; this document (including the generated table) matches the code; the frontend mirror agrees. |
| `backend/tests/error-taxonomy.test.ts` | Classification, statuses, retryability and user-safe rendering stay pinned (issue #48). |
| `backend/tests/api-contract.test.ts` | Failure envelopes over the wire carry codes that exist in the taxonomy, with `category`/`retryable` matching it, and this document stays linked from `API_CONTRACTS.md`. |
