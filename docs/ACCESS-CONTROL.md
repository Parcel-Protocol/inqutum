# Access control

Issue #47. Who may do what is decided in one table, enforced by the API, and read
(not re-implemented) by the UI.

- Table: [`shared/access-control.ts`](../shared/access-control.ts)
- Enforcement: [`backend/src/middleware/access-control.ts`](../backend/src/middleware/access-control.ts)
- Also served live at `GET /api/auth/roles`

**The UI is a convenience, not the boundary.** A hidden button is not a control.
Every action below is refused by the API when called directly, whatever the UI
showed.

## Roles

| Role         | Who | How they authenticate |
| ------------ | --- | --------------------- |
| `anonymous`  | A payer on the public pay page. | Nothing. |
| `end_user`   | A seller who proved control of their Stellar wallet. | Wallet session token (below). |
| `maintainer` | A human operator. | `MAINTAINER_API_TOKENS` bearer token. |
| `service`    | A machine actor (monitor, scheduled job). | `SERVICE_API_TOKENS` bearer token. |

## Capabilities

`own` means an `end_user` may do it **only on their own invoices**: the invoice's
seller wallet must equal the wallet in their session. Maintainers and services
act across sellers.

| Permission           | Routes | anonymous | end_user | maintainer | service |
| -------------------- | ------ | :-------: | :------: | :--------: | :-----: |
| `lifecycle:read`     | `GET /invoices/lifecycle` | ✓ | ✓ | ✓ | ✓ |
| `invoice:read`       | `GET /invoices/:id`, `/:id/payment-info` | ✓ | ✓ | ✓ | ✓ |
| `invoice:verify`     | `POST /invoices/:id/verify` | ✓ | ✓ | ✓ | ✓ |
| `invoice:create`     | `POST /invoices` | | own | | |
| `invoice:list`       | `GET /invoices` | | own | ✓ | ✓ |
| `invoice:stats`      | `GET /invoices/stats` | | own | ✓ | ✓ |
| `invoice:cancel`     | `POST /invoices/:id/cancel` | | own | ✓ | |
| `invoice:audit`      | `GET /invoices/:id/audit` | | own | ✓ | ✓ |
| `invoice:simulate`   | `POST /invoices/:id/simulate-payment` | | | ✓ | |
| `reconciliation:run` | `GET /api/reconciliation` | | | ✓ | ✓ |
| `monitor:read`       | `GET /payment/monitor/status` | | | ✓ | ✓ |
| `monitor:sync`       | `POST /payment/sync` | | | ✓ | ✓ |
| `stellar:read`       | `/stellar/*` | | ✓ | ✓ | ✓ |

Payers are open on purpose. A payer has no account, and `verify` is proven by the
on-chain transaction rather than by who asks. `simulate-payment` also needs
`ALLOW_SIMULATE=true` outside production; when that is off the route answers `404`
to everyone, so it does not reveal itself.

### Responses

| Situation | Status | `code` |
| --------- | ------ | ------ |
| No credentials, or an invalid / expired token, on a privileged route | `401` (+ `WWW-Authenticate: Bearer`) | `UNAUTHENTICATED` |
| Authenticated, but the role lacks the permission, or the invoice is not yours | `403` | `FORBIDDEN` |

An invalid or expired token on a **public** route is treated as anonymous rather
than failing the payer; only privileged routes report it.

## Wallet sign-in (`end_user`)

Freighter 2.x cannot sign arbitrary messages, so sign-in uses a challenge
transaction (SEP-10 in spirit, self-issued and never submitted):

1. The client builds a transaction from the wallet, **sequence 0**, with one
   `manageData` operation named `inqutum auth` carrying a random nonce, time
   bounds at most 5 minutes wide, no memo.
2. The wallet signs it (a Freighter prompt).
3. `POST /api/auth/session { "transaction": "<signed XDR>" }`. The server checks
   the shape, the time window, that the source account signed it, and that the
   challenge was not used before. It returns a session token.
4. The client sends `Authorization: Bearer <token>`.

Sequence 0 means the transaction can never be applied to the ledger, so signing it
cannot move funds. The constants live in
[`shared/wallet-auth.ts`](../shared/wallet-auth.ts).

Session tokens are stateless HMAC-signed values (`iq1.<claims>.<sig>`), valid for
`AUTH_SESSION_TTL_SECONDS` (default 1 hour, allowed 60 to 86400). Being stateless
they cannot be revoked before expiry, which is why they are short.

### Limits worth knowing

- **Replay protection is per process.** A challenge is single use within one
  server instance. With several instances a challenge could be exchanged once per
  instance inside its 5-minute window. Sign-in is rate limited and a session only
  grants what the wallet could already do; a shared store (Redis) is the upgrade.
- **Sessions are bound to a wallet, not to a device.** Anyone holding a token acts
  as that wallet until it expires.

## Operator and service tokens

Set comma-separated lists; rotate by adding the new token, deploying, then
removing the old one.

```
MAINTAINER_API_TOKENS=<token>,<token>
SERVICE_API_TOKENS=<token>
```

Tokens shorter than 24 characters are ignored with a warning. Generate one with
`openssl rand -base64 32`. Only a SHA-256 digest is kept in memory and comparison
is constant-time.

## Configuration

| Variable | Purpose |
| -------- | ------- |
| `AUTH_SESSION_SECRET` | HMAC key for wallet sessions, at least 32 characters. **Required in production**: without it `POST /auth/session` answers `503 SESSION_UNAVAILABLE` (the server never signs with a guessable key). Outside production a random per-process key is used if unset. |
| `AUTH_SESSION_TTL_SECONDS` | Session lifetime. |
| `MAINTAINER_API_TOKENS`, `SERVICE_API_TOKENS` | Operator and service credentials. |

Deploy step for existing installations: set `AUTH_SESSION_SECRET` before rolling
this out, or sellers cannot sign in and creating invoices returns `401`.
`scripts/deploy-smoke.mjs` signs in with a throwaway key and fails loudly if
sign-in is not configured.

## Adding a route

1. Add the permission to `PERMISSIONS` and to each role that should hold it in
   `shared/access-control.ts`. If an `end_user` should only reach their own
   resources, add it to `OWNED_PERMISSIONS`.
2. Put `requirePermission('<permission>')` on the route.
3. If the permission is owner-scoped, check the resource with `mayAccessSeller` in
   the handler.
4. Add it to the matrix in `backend/tests/access-control.test.ts`. That file also
   asserts every route on the invoice and monitor routers carries a guard, so a
   forgotten guard fails the suite.

## Relationship to the cancel signature

`REQUIRE_CANCEL_SIGNATURE` (issue #383) still works: when set, a cancel must also
carry a per-request seller signature. It is an extra proof on top of the session,
not a replacement. The session is what identifies the seller; a `sellerPublicKey`
in the request body that names someone else is refused.
