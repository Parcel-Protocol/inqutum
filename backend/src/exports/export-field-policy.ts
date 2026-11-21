/**
 * Permission-aware field redaction for invoice exports (#354).
 *
 * The export allow-list (EXPORT_FIELDS) decides which columns can ever leave
 * the system. This module decides, per viewer, how much of each allowed column
 * they get to see. Two viewers exist:
 *
 *  - `owner`    the seller exporting their own invoices. Sees every column.
 *  - `public`   a caller with no verified credentials. A wallet string is not
 *               proof of ownership, so they get the most restrictive view.
 *  - `operator` a maintainer or service account exporting any seller's data for
 *               support or reconciliation. Sees what is needed to identify and
 *               reconcile an invoice, but not the free-text a seller wrote or
 *               the full payment memo.
 *
 * An owner may additionally redact columns (e.g. before handing the file to an
 * accountant). Requests can only ever *narrow* a viewer's visibility, never
 * widen it, and an unknown viewer fails closed to the most restrictive policy.
 *
 * Redaction replaces the value but keeps the column, so every export has the
 * same shape for a given schema version and consumers do not need to branch.
 */

import type { Actor } from '../auth/actor';
import { EXPORT_FIELDS, type ExportField, type ExportRecord } from './export-fields';

export type ExportViewer = 'owner' | 'operator' | 'public';
export type FieldVisibility = 'full' | 'masked' | 'redacted';

export const REDACTED_MARKER = '[REDACTED]';

/** Characters of a masked value that stay visible (enough to find it, not to reuse it). */
const MASK_VISIBLE_CHARS = 4;
/** Values shorter than this are fully redacted rather than masked: masking would reveal most of them. */
const MASK_MIN_LENGTH = 8;

export const FIELD_POLICY: Readonly<Record<ExportViewer, Readonly<Record<ExportField, FieldVisibility>>>> = Object.freeze({
  owner: Object.freeze(Object.fromEntries(EXPORT_FIELDS.map((f) => [f, 'full'])) as Record<ExportField, FieldVisibility>),
  // Unauthenticated: only non-sensitive identifiers; every free-text or payment-linked column is withheld.
  public: Object.freeze({
    id: 'full',
    memo: 'redacted',
    status: 'full',
    amount: 'full',
    assetCode: 'full',
    assetIssuer: 'full',
    description: 'redacted',
    createdAt: 'full',
    expiresAt: 'full',
    paidAt: 'redacted',
    paymentTxHash: 'redacted',
  }) as Record<ExportField, FieldVisibility>,
  operator: Object.freeze({
    id: 'full',
    memo: 'masked',
    status: 'full',
    amount: 'full',
    assetCode: 'full',
    assetIssuer: 'full',
    description: 'redacted',
    createdAt: 'full',
    expiresAt: 'full',
    paidAt: 'full',
    // Public on-chain data, and what reconciliation needs.
    paymentTxHash: 'full',
  }) as Record<ExportField, FieldVisibility>,
});

export function isExportField(value: unknown): value is ExportField {
  return typeof value === 'string' && (EXPORT_FIELDS as readonly string[]).includes(value);
}

export function maskValue(value: string | number | null): string | number | null {
  if (value === null) return null;
  const text = String(value);
  return text.length >= MASK_MIN_LENGTH ? `${text.slice(0, MASK_VISIBLE_CHARS)}${REDACTED_MARKER}` : REDACTED_MARKER;
}

/** The visibility a viewer gets for a field once any extra redactions are applied. */
export function effectiveVisibility(
  viewer: ExportViewer,
  field: ExportField,
  extraRedactions: readonly ExportField[] = []
): FieldVisibility {
  // `?? 'redacted'`: a viewer or field missing from the table fails closed.
  const base: FieldVisibility = FIELD_POLICY[viewer]?.[field] ?? 'redacted';
  return extraRedactions.includes(field) ? 'redacted' : base;
}

export interface RedactedRecord {
  record: ExportRecord;
  /** Fields whose value was masked or removed in this record. */
  redacted: ExportField[];
}

/** Applies the viewer's policy to one record. Never mutates its input. */
export function redactRecord(
  record: ExportRecord,
  viewer: ExportViewer,
  extraRedactions: readonly ExportField[] = []
): RedactedRecord {
  const out = { ...record };
  const redacted: ExportField[] = [];
  for (const field of EXPORT_FIELDS) {
    const visibility = effectiveVisibility(viewer, field, extraRedactions);
    if (visibility === 'full') continue;
    const value = record[field];
    // A null stays null: there is nothing to hide, and it keeps "no value" distinguishable.
    if (value === null) continue;
    out[field] = visibility === 'masked' ? maskValue(value) : REDACTED_MARKER;
    redacted.push(field);
  }
  return { record: out, redacted };
}

/** Fields a viewer can never see in full, whatever the request says. Stable order. */
export function restrictedFields(viewer: ExportViewer, extraRedactions: readonly ExportField[] = []): ExportField[] {
  return EXPORT_FIELDS.filter((f) => effectiveVisibility(viewer, f, extraRedactions) !== 'full');
}

export type ExportAccess =
  | { ok: true; viewer: ExportViewer; /** Wallet whose invoices are exported. */ scope: string; /** Who owns (may download) the artifact. */ owner: string }
  | { ok: false; code: 'EXPORT_FORBIDDEN' | 'EXPORT_UNAUTHENTICATED'; message: string };

/**
 * Decides who may export whose data, and as which viewer.
 *
 *  - Presented-but-invalid credentials are refused, never downgraded to the
 *    legacy "caller asserts a wallet" path.
 *  - No credentials: the legacy "caller asserts a wallet" path is kept so
 *    existing clients still work, but asserting a wallet proves nothing, so the
 *    caller only gets the redacted `public` view. The full `owner` view
 *    requires an authenticated `end_user` bound to that wallet.
 *  - `end_user`: bound to the wallet they proved control of. They may not
 *    export, or claim to be, another wallet.
 *  - `maintainer` / `service`: may export any seller, but only as `operator`.
 *    The artifact is owned by the operator, so the seller cannot download it.
 */
export function resolveExportAccess(input: {
  actor: Actor | undefined;
  authFailed?: boolean;
  requester: string;
  scope?: string;
}): ExportAccess {
  const { actor, requester } = input;
  const scope = input.scope ?? requester;

  if (input.authFailed) {
    return { ok: false, code: 'EXPORT_UNAUTHENTICATED', message: 'The credentials provided are invalid or have expired' };
  }

  if (!actor || actor.role === 'anonymous') {
    return scope === requester
      ? { ok: true, viewer: 'public', scope, owner: requester }
      : { ok: false, code: 'EXPORT_FORBIDDEN', message: 'You can only export your own invoices' };
  }

  if (actor.role === 'end_user') {
    if (!actor.wallet || actor.wallet !== requester || scope !== requester) {
      return { ok: false, code: 'EXPORT_FORBIDDEN', message: 'You can only export your own invoices' };
    }
    return { ok: true, viewer: 'owner', scope, owner: requester };
  }

  if (actor.role === 'maintainer' || actor.role === 'service') {
    return { ok: true, viewer: 'operator', scope, owner: actor.subject };
  }

  return { ok: false, code: 'EXPORT_FORBIDDEN', message: 'Your role is not permitted to export data' };
}
