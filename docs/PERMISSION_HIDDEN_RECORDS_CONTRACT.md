# Contract: permission changes and hidden records (#385)

These guarantees already hold in the code. `backend/tests/permission-changes-hidden-records.contract.test.ts`
pins them together so a change that breaks one fails a test, not production.
Each group covers the normal, failure, retry and authorization paths.

## Permission changes

| Guarantee | Where |
|-----------|-------|
| A diff accounts for every permission exactly once: `added + retained = proposed`, `revoked + retained = current` | `PermissionDiffService` |
| Applying a diff then its `reversalPlan` restores the original set | `PermissionDiffService` |
| Diffing is read-only and repeatable; it never mutates `DEFAULT_ROLE_PERMISSIONS` | `PermissionDiffService` |
| Granting any high-privilege permission to a non-owner role is `CRITICAL` and needs a quorum, for every role | `HIGH_PRIVILEGE_PERMISSIONS` |
| Only `ADMIN` and `OWNER` may generate a diff; a non-owner cannot assign a role at or above their own | `403` |
| A revoked session is rejected on the very next request; revoking twice is harmless; other wallets are unaffected | `SessionRevocationStore` |

## Hidden records

A hidden record must be indistinguishable from one that does not exist.

| Guarantee | Where |
|-----------|-------|
| A viewer pages only through records they may see | `paginateStable` |
| Page items, `hasMore` and `nextCursor` are identical with or without hidden rows (no leak through page size) | `paginateStable` |
| A record that becomes forbidden between pages is never returned later | `paginateStable` |
| A throwing permission check fails closed | `paginateStable` |
| A cursor minted for one viewer is refused for another | `InvalidStableCursorError('scope')` |
| Private dispute evidence reaches only its author and maintainers; its label and reference never appear in anyone else's projection; projecting never mutates the record | `DisputeWorkflowService.get` |
| Archiving hides an invoice from the active set but keeps it resolvable; a second archive is refused; unknown ids leave no record; actor and reason are mandatory | `InvoiceArchiveService` |

## Edge cases and recovery

- **Permission check unavailable.** Reads fail closed (nothing is shown), not open.
- **Wrong role assignment.** Use the report's `reversalRecipe` / `reversalPlan`;
  it restores the exact prior permissions.
- **Compromised session.** Revoke it (`POST /api/auth/revoke`). It stops working
  on the next request.
- **Wrongly archived invoice.** Restore it; the history keeps both transitions.

No production code changed for this item, so no migration is needed.
