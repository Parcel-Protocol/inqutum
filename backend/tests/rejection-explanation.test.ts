import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  REJECTION_REASON_CATALOG,
  REJECTION_EXPLANATION_SCHEMA_VERSION,
  explainRejection,
  buildRejectedOperationEnvelope,
  type RejectionReasonCode,
} from '../src/errors/rejection-explanation';
import { evaluateInvoiceRequest, type BusinessPolicy, DEFAULT_POLICY } from '../src/domain/policy';
import { ConflictError } from '../src/concurrency/optimistic-lock';
import { ExportForbiddenError } from '../src/exports/export-service';
import { TrendExportPermissionError } from '../src/exports/trend-export';
import { PolicySimulationPermissionError, PolicySimulationValidationError } from '../src/domain/policy-simulation';

describe('User-Facing Explanation Framework for Rejected Operations', () => {
  it('ensures every expected rejection in the catalog has a stable reason code and actionable recovery hints', () => {
    const entries = Object.entries(REJECTION_REASON_CATALOG);
    assert.ok(entries.length >= 30, 'Catalog must cover all expected domain rejection reasons');

    for (const [key, entry] of entries) {
      assert.equal(entry.reasonCode, key);
      assert.ok(entry.title.length > 0, `${key} must have a user-safe title`);
      assert.ok(entry.summary.length > 0, `${key} must have a user-safe summary`);
      assert.ok(entry.recoveryAction.length > 0, `${key} must have a recoveryAction`);
      assert.ok(Array.isArray(entry.recoveryHints) && entry.recoveryHints.length >= 1, `${key} must provide recoveryHints`);
      for (const [idx, hint] of entry.recoveryHints.entries()) {
        assert.equal(hint.step, idx + 1);
        assert.ok(hint.action.length > 0);
        assert.equal(typeof hint.automatedRetryEligible, 'boolean');
      }
    }
  });

  it('maps low-level Zod validation errors into field-specific explanations and recovery hints', () => {
    const schema = z.object({
      sellerPublicKey: z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar address'),
      amount: z.number().positive('Amount must be positive'),
      customerEmail: z.string().email('Invalid email'),
    });

    const parsed = schema.safeParse({
      sellerPublicKey: 'bad-key',
      amount: -5,
      customerEmail: 'not-an-email',
    });
    assert.equal(parsed.success, false);

    const explanation = explainRejection(parsed.error, { correlationId: 'corr-val-1' });
    assert.equal(explanation.schemaVersion, REJECTION_EXPLANATION_SCHEMA_VERSION);
    assert.equal(explanation.reasonCode, 'VALIDATION_FAILED');
    assert.equal(explanation.category, 'VALIDATION');
    assert.equal(explanation.httpStatus, 400);
    assert.equal(explanation.retryable, false);
    assert.equal(explanation.userSafe, true);
    assert.equal(explanation.correlationId, 'corr-val-1');
    assert.equal(explanation.fieldErrors?.length, 3);
    assert.equal(explanation.fieldErrors?.[0].field, 'sellerPublicKey');
    assert.match(explanation.fieldErrors?.[0].hint ?? '', /56-character Stellar public key/);
    assert.equal(explanation.recoveryHints.length, 3);
    assert.equal(explanation.recoveryHints[1].targetField, 'amount');
  });

  it('maps policy denials into POLICY explanations with policyConstraint metadata', () => {
    const strictPolicy: BusinessPolicy = {
      invoice: {
        ...DEFAULT_POLICY.invoice,
        minAmount: 10,
        maxAmount: 500,
        allowedAssets: ['XLM', 'USDC'],
      },
    };

    const highDecision = evaluateInvoiceRequest({ amount: 1200, assetCode: 'XLM' }, strictPolicy);
    const highExpl = explainRejection(highDecision);
    assert.equal(highExpl.reasonCode, 'AMOUNT_TOO_HIGH');
    assert.equal(highExpl.category, 'POLICY');
    assert.equal(highExpl.httpStatus, 422);
    assert.equal(highExpl.policyConstraint?.rule, 'AMOUNT_TOO_HIGH');
    assert.equal(highExpl.policyConstraint?.limit, 500);
    assert.ok(highExpl.recoveryHints.some((h) => /Reduce the amount/i.test(h.action)));

    const assetDecision = evaluateInvoiceRequest({ amount: 50, assetCode: 'EURC' }, strictPolicy);
    const assetExpl = explainRejection(assetDecision);
    assert.equal(assetExpl.reasonCode, 'ASSET_NOT_ALLOWED');
    assert.equal(assetExpl.category, 'POLICY');
    assert.deepEqual(assetExpl.policyConstraint?.allowedValues, ['XLM', 'USDC']);

    const proposalErr = new PolicySimulationValidationError(['minAmount must not exceed maxAmount']);
    const proposalExpl = explainRejection(proposalErr);
    assert.equal(proposalExpl.reasonCode, 'INVALID_POLICY_PROPOSAL');
    assert.equal(proposalExpl.category, 'VALIDATION');
  });

  it('maps permission and authorization rejections accurately', () => {
    const exportDenied = explainRejection(new ExportForbiddenError());
    assert.equal(exportDenied.reasonCode, 'EXPORT_FORBIDDEN');
    assert.equal(exportDenied.category, 'PERMISSION');
    assert.equal(exportDenied.httpStatus, 403);

    const sensitiveDimDenied = explainRejection(
      new TrendExportPermissionError('SENSITIVE_DIMENSION_FORBIDDEN', 'customerEmail is blocked', ['customerEmail'])
    );
    assert.equal(sensitiveDimDenied.reasonCode, 'SENSITIVE_DIMENSION_FORBIDDEN');
    assert.equal(sensitiveDimDenied.category, 'PERMISSION');
    assert.equal(sensitiveDimDenied.httpStatus, 403);

    const simDenied = explainRejection(new PolicySimulationPermissionError());
    assert.equal(simDenied.reasonCode, 'PERMISSION_DENIED');
    assert.equal(simDenied.category, 'PERMISSION');
    assert.equal(simDenied.httpStatus, 403);

    const sellerDenied = explainRejection({ code: 'UNAUTHORIZED_SELLER', message: 'Wrong wallet connected' });
    assert.equal(sellerDenied.reasonCode, 'UNAUTHORIZED_SELLER');
    assert.equal(sellerDenied.category, 'PERMISSION');
    assert.ok(sellerDenied.recoveryHints.some((h) => /Freighter/i.test(h.action)));
  });

  it('maps stale-state and optimistic concurrency rejections with retry guidance', () => {
    const conflictErr = new ConflictError('invoice', 'inv-123', 2, 3);
    const conflictExpl = explainRejection(conflictErr);
    assert.equal(conflictExpl.reasonCode, 'STALE_STATE_CONFLICT');
    assert.equal(conflictExpl.category, 'STALE_STATE');
    assert.equal(conflictExpl.httpStatus, 409);
    assert.equal(conflictExpl.retryable, true);
    assert.equal(conflictExpl.recoveryHints[0].automatedRetryEligible, true);

    const expiredExpl = explainRejection({ code: 'INVOICE_EXPIRED' });
    assert.equal(expiredExpl.reasonCode, 'INVOICE_EXPIRED');
    assert.equal(expiredExpl.category, 'STALE_STATE');
    assert.equal(expiredExpl.retryable, false);

    const paidExpl = explainRejection({ code: 'INVOICE_ALREADY_PAID' });
    assert.equal(paidExpl.reasonCode, 'INVOICE_ALREADY_PAID');
    assert.equal(paidExpl.category, 'STALE_STATE');
  });

  it('provides a user-safe fallback for unexpected errors without leaking internal details or secrets', () => {
    const secretSeed = 'S' + 'A'.repeat(55);
    const dbCrash = new Error(
      `SELECT * FROM invoices WHERE secret='${secretSeed}' failed: relation pg_catalog.pg_type syntax error at /home/app/db.ts:42`
    );

    const envelope = buildRejectedOperationEnvelope(dbCrash, { correlationId: 'corr-500' });
    assert.equal(envelope.success, false);
    assert.equal(envelope.code, 'UNEXPECTED_FAILURE');
    assert.equal(envelope.category, 'UNEXPECTED');
    assert.equal(envelope.explanation.httpStatus, 500);
    assert.equal(envelope.explanation.userSafe, true);
    assert.equal(envelope.correlationId, 'corr-500');

    // Must not leak SQL, file paths, or Stellar secret seed
    const serialized = JSON.stringify(envelope);
    assert.ok(!serialized.includes('SELECT * FROM'));
    assert.ok(!serialized.includes('pg_catalog'));
    assert.ok(!serialized.includes('/home/app'));
    assert.ok(!serialized.includes(secretSeed));
    assert.ok(envelope.explanation.recoveryHints.length >= 2);
  });
});
