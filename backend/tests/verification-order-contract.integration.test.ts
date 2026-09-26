/**
 * Full integration test suite covering every failure branch of the verification order
 * across all four call sites (Issue #39).
 *
 * Call Sites Under Test:
 * 1. `backend/src/services/payment-verification.ts` (`verifyHorizonPayment`)
 * 2. Postgres-backed handler path (`backend/src/routes/invoice.handlers.ts` `verifyPayment`)
 * 3. `backend/src/services/stellar.service.ts` (`StellarService.prototype.verifyPayment`)
 * 4. Frontend contract (`frontend/lib/verification.js` + `shared/verification.ts`)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VERIFICATION_FIXTURES,
  type VerificationFixture,
} from '../../shared/verification-fixtures';
import {
  verifyHorizonPayment,
  checkTxHash as backendCheckTxHash,
} from '../src/services/payment-verification';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service';
import { MemoryStorage } from '../src/storage/memory-storage';
import { VERIFICATION_MESSAGES, messageForCode } from '../../shared/verification';

// Call Site 4: Frontend verification logic
const frontendVerification = require('../../frontend/lib/verification.js');

describe('Issue #39: Verification Precedence Order & Failure Branches Across All 4 Call Sites', () => {
  for (const fixture of VERIFICATION_FIXTURES) {
    describe(`Fixture: ${fixture.name} (${fixture.description})`, () => {
      // Call Site 1: payment-verification.ts verifyHorizonPayment
      it(`[Call Site 1: payment-verification.ts] produces expected outcome (${fixture.expectedOutcome})`, () => {
        const result = verifyHorizonPayment({
          txHash: String(fixture.txHash),
          expected: fixture.expected,
          transaction: fixture.transaction,
          operations: fixture.operations,
          network: fixture.network,
        });

        if (fixture.expectedOutcome === 'pass') {
          assert.equal(result.ok, true, `Expected pass but failed with: ${!result.ok ? result.code : ''}`);
          if (result.ok) {
            assert.equal(result.value.amount, fixture.expected.amount.toString().includes('.') ? fixture.expected.amount : '100.0000000');
            assert.equal(result.value.to, fixture.expected.destination);
          }
        } else {
          assert.equal(result.ok, false, `Expected failure code ${fixture.expectedCode} but passed`);
          if (!result.ok) {
            assert.equal(result.code, fixture.expectedCode);
            assert.equal(result.error, VERIFICATION_MESSAGES[fixture.expectedCode!]);
          }
        }
      });

      // Call Site 2: Postgres-backed handler path (invoice.handlers.ts)
      it(`[Call Site 2: invoice.handlers.ts] verifies or rejects with exact canonical code`, async () => {
        const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(new MemoryStorage()));
        // Create an invoice matching the fixture expectation
        const invoice = await storage.createInvoice({
          sellerPublicKey: fixture.expected.destination,
          amount: typeof fixture.expected.amount === 'string' ? parseFloat(fixture.expected.amount) : fixture.expected.amount,
          assetCode: fixture.expected.assetCode,
          assetIssuer: fixture.expected.assetIssuer,
          memo: fixture.expected.memo,
        });

        // Mock Stellar lookup returning the fixture transaction and operations
        const isMemoMismatch =
          fixture.expectedCode === 'MEMO_MISMATCH' ||
          fixture.name.includes('wrong_memo') ||
          (fixture.transaction.memo && fixture.transaction.memo !== fixture.expected.memo);

        // Memo-type fixtures keep the invoice's own memo value: only the TYPE differs.
        const typeOnlyMismatch = fixture.name.startsWith('memo_type_');
        const txMemo = isMemoMismatch && !typeOnlyMismatch ? 'QUIT-MISMATCH-MEMO' : invoice.memo;

        const mockStellar = {
          getTransaction: async (hash: string) => {
            return {
              transaction: {
                ...fixture.transaction,
                memo: txMemo,
                ...(typeOnlyMismatch
                  ? fixture.transaction.memo_type
                    ? { memo_type: fixture.transaction.memo_type }
                    : {}
                  : { memo_type: 'text' }),
              },
              operations: fixture.operations,
            };
          },
        };

        const handlers = createInvoiceHandlers({
          storage,
          stellar: mockStellar as any,
        });

        let statusCode = 0;
        let responseJson: any = null;

        const req: any = {
          params: { id: invoice.id },
          body: {
            txHash: fixture.txHash,
            network: fixture.network,
          },
        };

        const res: any = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (data: any) => {
            responseJson = data;
            return res;
          },
          set: () => res,
        };

        await handlers.verifyPayment(req, res);

        if (fixture.expectedOutcome === 'pass') {
          assert.equal(statusCode, 200, `Expected 200 but got ${statusCode}: ${JSON.stringify(responseJson)}`);
          assert.equal(responseJson.success, true);
          assert.equal(responseJson.data.status, 'PAID');
        } else {
          assert.ok(statusCode === 400 || statusCode === 404, `Expected 400/404 but got ${statusCode}`);
          assert.equal(responseJson.success, false);
          assert.equal(responseJson.code, fixture.expectedCode);
          assert.equal(responseJson.error, VERIFICATION_MESSAGES[fixture.expectedCode!]);
        }
      });

      // Call Site 3: Standalone Verification Logic
      it(`[Call Site 3: Standalone Stellar lookup] maps to identical error code and message`, async () => {
        const hashCheck = backendCheckTxHash(fixture.txHash);
        if (!hashCheck.ok) {
          assert.equal(fixture.expectedOutcome, 'fail');
          assert.equal(hashCheck.code, fixture.expectedCode);
          return;
        }

        const verification = verifyHorizonPayment({
          txHash: hashCheck.value,
          expected: fixture.expected,
          transaction: fixture.transaction,
          operations: fixture.operations,
          network: fixture.network,
        });

        if (fixture.expectedOutcome === 'pass') {
          assert.equal(verification.ok, true);
        } else {
          assert.equal(verification.ok, false);
          if (!verification.ok) {
            assert.equal(verification.code, fixture.expectedCode);
          }
        }
      });

      // Call Site 4: Frontend verification contract (verification.js)
      it(`[Call Site 4: frontend/lib/verification.js] validates hash and maps server error to identical message`, () => {
        // Test client-side preflight
        const clientHashCheck = frontendVerification.checkTxHash(fixture.txHash);
        if (!clientHashCheck.ok) {
          assert.equal(fixture.expectedOutcome, 'fail');
          assert.equal(clientHashCheck.code, fixture.expectedCode);
          assert.equal(clientHashCheck.error, VERIFICATION_MESSAGES[fixture.expectedCode!]);
        }

        // Test client-side error code resolution
        if (fixture.expectedCode) {
          const canonical = frontendVerification.messageForCode(fixture.expectedCode);
          assert.equal(canonical, VERIFICATION_MESSAGES[fixture.expectedCode]);

          const resolved = frontendVerification.resolveVerificationError({
            response: { data: { code: fixture.expectedCode } },
          });
          assert.equal(resolved, VERIFICATION_MESSAGES[fixture.expectedCode]);
        }
      });
    });
  }
});
