const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRejectionExplanation } = require('../lib/rejection-explanation');

describe('Frontend client rejection explanation consistency', () => {
  it('preserves structured backend explanation envelopes', () => {
    const apiError = {
      response: {
        status: 422,
        data: {
          success: false,
          code: 'AMOUNT_TOO_HIGH',
          correlationId: 'corr-client-1',
          explanation: {
            schemaVersion: '1.0',
            reasonCode: 'AMOUNT_TOO_HIGH',
            category: 'POLICY',
            title: 'Invoice amount exceeds policy maximum',
            summary: 'Amount must be at most 500.',
            recoveryAction: 'Lower the invoice amount within the policy cap.',
            recoveryHints: [
              { step: 1, action: 'Reduce the amount to at most 500.', targetField: 'amount', automatedRetryEligible: false },
            ],
            retryable: false,
          },
        },
      },
    };

    const resolved = resolveRejectionExplanation(apiError);
    assert.equal(resolved.reasonCode, 'AMOUNT_TOO_HIGH');
    assert.equal(resolved.category, 'POLICY');
    assert.equal(resolved.title, 'Invoice amount exceeds policy maximum');
    assert.equal(resolved.recoveryHints.length, 1);
    assert.equal(resolved.recoveryHints[0].targetField, 'amount');
    assert.equal(resolved.correlationId, 'corr-client-1');
  });

  it('normalizes legacy or raw error payloads and strips internal leaks', () => {
    const staleResolved = resolveRejectionExplanation({ code: 'STALE_STATE_CONFLICT' });
    assert.equal(staleResolved.reasonCode, 'STALE_STATE_CONFLICT');
    assert.equal(staleResolved.category, 'STALE_STATE');
    assert.equal(staleResolved.retryable, true);

    const leakedSql = resolveRejectionExplanation({
      code: 'UNKNOWN_DB_ERR',
      message: 'SELECT * FROM pg_catalog WHERE secret = ' + ('S' + 'B'.repeat(55)),
    });
    assert.equal(leakedSql.reasonCode, 'UNEXPECTED_FAILURE');
    assert.equal(leakedSql.category, 'UNEXPECTED');
    assert.ok(!leakedSql.summary.includes('pg_catalog'));
    assert.ok(!leakedSql.summary.includes('S' + 'B'.repeat(55)));
  });
});
