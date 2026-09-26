# Assets

## An asset is a pair, not a code

On Stellar an asset is identified by **`(code, issuer)`**, never by the code
alone. `XLM` is the one exception: it is the *native* asset and has no issuer.

This matters more than it first appears. Anyone can issue a credit asset and
give it any four- or twelve-character code they like — including `USDC`, and
including `XLM`. A code on its own identifies nothing.

| | Code | Issuer | Identified by |
| --- | --- | --- | --- |
| Native lumens | `XLM` | — | `asset_type === "native"` |
| Circle USDC (testnet) | `USDC` | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | code **and** issuer |
| A look-alike | `USDC` | anyone else | a different asset entirely |

## How Quittance represents assets

`backend/src/utils/asset-helpers.ts` resolves both sides of a settlement into
one of three identities:

| Identity | Meaning |
| --- | --- |
| `native` | The native asset. Horizon reported `asset_type: "native"`. |
| `credit` | A credit asset pinned to its issuer. |
| `unpinned` | A credit asset with **no issuer**. Comparable to nothing. |

`unpinned` exists so the missing-issuer case has to be handled rather than
being silently treated as a wildcard.

## Invoices

- An invoice is **native** only when it names `XLM` *and* records no issuer.
- An invoice naming any other code **must** record an issuer. This is enforced
  at creation (`createInvoiceSchema`), because an invoice for an unpinned asset
  could never be settled — verification refuses it — so accepting one would
  only produce an invoice that can never be paid.
- `XLM` must **not** carry an issuer. A code of `XLM` with an issuer is a
  credit asset that merely looks like lumens, and treating it as native is the
  confusion this rule exists to prevent.

## Create is forgiving, verify is strict (issue #8)

Two different jobs, deliberately kept apart:

| | At invoice creation | At verification |
| --- | --- | --- |
| Asset code | Trimmed and **uppercased** (`usdc` becomes `USDC`), then must be 1-12 letters/digits | Compared **byte-for-byte** with what Horizon reports |
| Issuer | Must be a well-formed `G...` Ed25519 strkey **with a valid checksum**; never case-folded, so `g...` is rejected, not fixed | Compared **byte-for-byte**; no trimming, no case folding |
| Owner | `assetCodeSchema` / `assetIssuerSchema` in `backend/src/utils/validation.ts` | `assetsMatch` in `backend/src/utils/asset-helpers.ts` |

Normalizing on create means a seller who types `usdc` gets an invoice that can
actually be paid. Keeping verify exact means no payment in a look-alike asset or
to a different issuer can ever settle an invoice. Do **not** relax the verify
side for convenience: base32 issuer keys are case-significant, and a lenient
match is a security bug, not a usability win.

Existing data: `db/migrations/001-normalize-asset-codes.sql` (applied by
`npm run db:migrate`) rewrites the code of still-`PENDING` invoices to the
canonical form. Paid and closed invoices are left alone. The file also contains
a query to list invoices that can never be settled (no issuer, malformed code).

## Adding an asset to the frontend

`frontend/lib/assets.ts` holds the assets a seller can choose. Every entry
except `XLM` must carry the issuer for the network it belongs to. Testnet and
mainnet issuers differ; do not copy one into the other.

See [VERIFY.md](./VERIFY.md) for how these identities are compared at
settlement.
