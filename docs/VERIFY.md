# Payment verification

Every verify path — the MVP `/api/invoices/:id/verify` route, the Postgres
invoice controller, and `stellar.service` — routes through
`backend/src/services/payment-verification.ts`, so the checks and their
rejection codes stay identical everywhere.

The module is pure: callers fetch the transaction and its operations from
Horizon and hand them in.

## Order of checks

Checks run in a fixed order so every caller reports the same *first* failure:

1. **Transaction hash** — 64 hexadecimal characters, rejected before spending a
   Horizon round trip (`MISSING_TX_HASH`, `INVALID_TX_HASH`)
2. **Network** — a testnet payment cannot settle a pubnet invoice
   (`NETWORK_MISMATCH`)
3. **Payment operation** — the transaction must contain one
   (`NO_PAYMENT_OPERATION`)
4. **Memo** — must equal the invoice memo (`MEMO_MISMATCH`)
5. **Destination** — must be the seller's account (`DESTINATION_MISMATCH`)
6. **Amount** — compared at Stellar's 7-decimal precision (`AMOUNT_MISMATCH`)
7. **Asset** — code *and* issuer (`ASSET_MISMATCH`)

## Asset matching

This is the check that most often looks simpler than it is. A Stellar asset is
the pair `(code, issuer)` — see [ASSETS.md](./ASSETS.md) — so the codes matching
proves nothing on its own.

Both sides are resolved to an identity and compared:

| Invoice | Payment | Result |
| --- | --- | --- |
| native `XLM` | `asset_type: native` | **settles** |
| native `XLM` | credit asset coded `XLM` | `ASSET_MISMATCH` |
| `USDC` from issuer A | `USDC` from issuer A | **settles** |
| `USDC` from issuer A | `USDC` from issuer B | `ASSET_MISMATCH` |
| `USDC` from issuer A | `asset_type: native` | `ASSET_MISMATCH` |
| `USDC` with no issuer | anything | `ASSET_MISMATCH` |

Two of those rows are the reason this exists:

- **A credit asset coded `XLM` must never settle a native invoice.** Nothing
  stops someone issuing an asset whose code is the three characters `XLM`. If
  matching compared codes, that worthless token would mark the invoice `PAID`
  and the seller would hold nothing of value. The *type* decides, not the code.
- **An unpinned invoice settles with nothing.** A credit invoice that records
  no issuer names an asset nobody pinned, and an asset nobody pinned is not one
  anyone agreed to accept. It fails closed rather than matching any token that
  happens to share the code. Invoice creation rejects this case up front, so it
  should be unreachable — the check is the second line.

## Replay prevention and idempotency

To guarantee proof-of-payment integrity (issue #6), every transaction hash consumed to verify an invoice is recorded and globally deduplicated across invoices:

- **Idempotency**: Submitting a verification request with the same transaction hash for an invoice that has already been verified as `PAID` with that transaction is idempotent and returns `200 OK`.
- **Cross-invoice replay prevention**: A transaction hash can settle at most one invoice. Submitting an already-used transaction hash against a different invoice is rejected with code `TX_HASH_ALREADY_USED`. Both the Postgres schema (via unique index on `payment_tx_hash`) and in-memory storage guard against concurrent races atomically.

## Rejection codes

Every code has one user-facing message, defined once in
`VERIFICATION_MESSAGES` and mirrored in `frontend/lib/verification.js`:

| Code | Message | Description |
| --- | --- | --- |
| `MISSING_TX_HASH` | Transaction hash is required | No transaction hash provided |
| `INVALID_TX_HASH` | Transaction hash must be 64 hexadecimal characters | Malformed transaction hash |
| `NETWORK_MISMATCH` | Transaction is on a different Stellar network | Testnet payment on Pubnet invoice or vice-versa |
| `NO_PAYMENT_OPERATION` | No payment operation found in transaction | Transaction has no payment operation |
| `MEMO_MISMATCH` | Memo mismatch | Memo does not match invoice memo |
| `DESTINATION_MISMATCH` | Payment destination mismatch | Payment not sent to invoice seller account |
| `AMOUNT_MISMATCH` | Amount mismatch | Amount does not match expected amount to 7-decimal stroop precision |
| `ASSET_MISMATCH` | Asset mismatch | Asset code or issuer mismatch, fake XLM credit, or unpinned asset |
| `TRANSACTION_NOT_FOUND` | Transaction not found on Stellar | Horizon does not recognize the transaction hash |
| `TX_HASH_ALREADY_USED` | Transaction hash has already been used for another invoice | Replay prevention: tx hash was already consumed by another invoice |
| `INVOICE_ALREADY_PAID` | Invoice has already been paid | Attempting to verify an already-paid invoice with a different tx hash |
| `INVOICE_EXPIRED` | Invoice has expired and can no longer accept payment | Payment verification attempted after `expiresAt` |
| `INVOICE_NOT_PENDING` | Invoice is not pending | Invoice is cancelled or otherwise not in payable state |

### Migration Notes for API Consumers

- **Error envelope**: All payment verification errors return a standard JSON object containing both `error` (human-readable string) and `code` (machine-readable enum from the table above).
- **Idempotent verification**: Repeating `/verify` with the exact same `txHash` on a paid invoice now succeeds with `200 OK` instead of failing with `400 INVOICE_ALREADY_PAID`.

## Shared Verification Fixtures and Drift Detection

To avoid behavioral drift across call sites (issue #11), all four verification call sites:
1. `backend/src/services/payment-verification.ts` (`verifyHorizonPayment`)
2. `frontend/lib/verification.js` (`verifyHorizonPayment`)
3. `backend/src/services/stellar.service.ts` (`verifyPayment`)
4. `backend/src/routes/invoice.handlers.ts` (`verifyPayment` route handler)

are verified against `fixtures/verification-fixtures.json`.

### Adding a new fixture

When discovering a new verification edge case:
1. Add an entry to `fixtures/verification-fixtures.json`:
   ```json
   {
     "id": "unique-fixture-id",
     "description": "Clear explanation of the scenario",
     "input": {
       "txHash": "<64-hex-characters>",
       "network": "TESTNET",
       "expected": {
         "memo": "...",
         "amount": "...",
         "destination": "...",
         "assetCode": "...",
         "assetIssuer": "...",
         "network": "TESTNET"
       },
       "transaction": { "memo": "...", "memo_type": "text" },
       "operations": [ { "type": "payment", ... } ]
     },
     "expectedOutcome": {
       "ok": false,
       "code": "CODE_NAME",
       "error": "Exact message from VERIFICATION_MESSAGES"
     }
   }
   ```
2. Run the test suites:
   ```bash
   node --test tests/*.test.mjs
   cd backend && npm test
   cd ../frontend && npm test
   ```

## Tests

```bash
cd backend && npm test
cd frontend && npm test
node --test tests/*.test.mjs
```

- `tests/asset-helpers.test.ts` — asset identity and matching, including fake-`XLM` and unpinned cases
- `tests/payment-verification.test.ts` — check order, stroop precision, and rejections
- `tests/verify-amount-tolerance.test.ts` — fixed-point string/BigInt stroop math avoiding float rounding flaws
- `tests/verification-drift.test.ts` — tests all four verification call sites against shared fixtures
- `tests/invoice-handlers.test.ts` — invoice HTTP API parity across memory and Postgres stores, idempotency, and replay prevention
- `tests/invoice-payment-loop.test.ts` — create → pay → verify → `PAID` against the real Express app with a stubbed Horizon

