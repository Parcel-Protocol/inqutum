/**
 * Verification contract drift detection test suite for frontend (Issue #11).
 *
 * Verifies that the frontend implementation (lib/verification.js) strictly
 * conforms to the shared version-controlled verification fixtures.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const verification = require('../lib/verification.js');

const fixturesPath = path.resolve(__dirname, '../../fixtures/verification-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

describe('Frontend Verification Drift Detection (Issue #11)', () => {
  it('loads version-controlled fixtures', () => {
    assert.ok(Array.isArray(fixtures));
    assert.ok(fixtures.length >= 10, `Expected >= 10 fixtures, found ${fixtures.length}`);
  });

  for (const fixture of fixtures) {
    it(`evaluates fixture [${fixture.id}] correctly: ${fixture.description}`, () => {
      const input = {
        txHash: fixture.input.txHash,
        expected: fixture.input.expected,
        transaction: fixture.input.transaction,
        operations: fixture.input.operations,
        network: fixture.input.network,
      };

      const result = verification.verifyHorizonPayment(input);

      const actualSummary = {
        ok: result.ok,
        code: result.ok ? null : result.code,
        error: result.ok ? null : result.error,
      };

      assert.deepStrictEqual(
        actualSummary,
        fixture.expectedOutcome,
        `Frontend verification drifted from expected outcome for fixture [${fixture.id}]`
      );
    });
  }
});
