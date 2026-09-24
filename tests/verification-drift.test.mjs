import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import test, { describe, it } from 'node:test';

register('./export-loader.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const frontendVerification = require('../frontend/lib/verification.js');
const backendVerification = await import('../backend/src/services/payment-verification.ts');

const fixturesPath = path.resolve(process.cwd(), 'fixtures/verification-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

describe('Verification Drift Detection — Shared Fixtures', () => {
  it('loads a non-empty set of version-controlled fixtures', () => {
    assert.ok(Array.isArray(fixtures));
    assert.ok(fixtures.length >= 10, `Expected at least 10 fixtures, found ${fixtures.length}`);
  });

  for (const fixture of fixtures) {
    it(`evaluates fixture [${fixture.id}] identically in frontend and backend: ${fixture.description}`, () => {
      const input = {
        txHash: fixture.input.txHash,
        expected: fixture.input.expected,
        transaction: fixture.input.transaction,
        operations: fixture.input.operations,
        network: fixture.input.network,
      };

      const backendResult = backendVerification.verifyHorizonPayment(input);
      const frontendResult = frontendVerification.verifyHorizonPayment(input);

      const expectedOutcome = fixture.expectedOutcome;

      // Normalize results for exact comparison
      const backendSummary = {
        ok: backendResult.ok,
        code: backendResult.ok ? null : backendResult.code,
        error: backendResult.ok ? null : backendResult.error,
      };

      const frontendSummary = {
        ok: frontendResult.ok,
        code: frontendResult.ok ? null : frontendResult.code,
        error: frontendResult.ok ? null : frontendResult.error,
      };

      // Assert backend matches expectedOutcome
      assert.deepStrictEqual(
        backendSummary,
        expectedOutcome,
        `Backend verification result drifted from expected outcome for fixture [${fixture.id}]`
      );

      // Assert frontend matches expectedOutcome
      assert.deepStrictEqual(
        frontendSummary,
        expectedOutcome,
        `Frontend verification result drifted from expected outcome for fixture [${fixture.id}]`
      );

      // Assert frontend matches backend
      assert.deepStrictEqual(
        frontendSummary,
        backendSummary,
        `Frontend verification drifted from backend verification for fixture [${fixture.id}]`
      );
    });
  }
});
