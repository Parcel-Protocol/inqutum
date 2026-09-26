const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VERIFICATION_FIXTURES,
} = require('../../shared/verification-fixtures.ts');
const {
  checkTxHash,
  messageForCode,
  resolveVerificationError,
} = require('../lib/verification.js');
const { VERIFICATION_MESSAGES } = require('../../shared/verification.ts');

test('Frontend Verification Contract: validates txHash preflight and maps all canonical codes across fixtures', () => {
  for (const fixture of VERIFICATION_FIXTURES) {
    const hashCheck = checkTxHash(fixture.txHash);
    if (!hashCheck.ok) {
      assert.equal(fixture.expectedOutcome, 'fail');
      assert.equal(hashCheck.code, fixture.expectedCode);
      assert.equal(hashCheck.error, VERIFICATION_MESSAGES[fixture.expectedCode]);
    }

    if (fixture.expectedCode) {
      const msg = messageForCode(fixture.expectedCode);
      assert.equal(msg, VERIFICATION_MESSAGES[fixture.expectedCode]);

      const resolved = resolveVerificationError({
        response: { data: { code: fixture.expectedCode } },
      });
      assert.equal(resolved, VERIFICATION_MESSAGES[fixture.expectedCode]);
    }
  }
});
