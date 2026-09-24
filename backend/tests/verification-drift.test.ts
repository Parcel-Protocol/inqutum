/**
 * Verification contract drift detection test suite (Issue #11).
 *
 * Runs the shared, version-controlled fixture set across all four verification
 * call sites to guarantee behavioral and textual synchronization:
 *
 * 1. backend pure service: verifyHorizonPayment (payment-verification.ts)
 * 2. frontend client mirror: verifyHorizonPayment (verification.js)
 * 3. backend stellar service: stellarService.verifyPayment (stellar.service.ts)
 * 4. backend HTTP routes: createInvoiceHandlers.verifyPayment (invoice.handlers.ts)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

import { verifyHorizonPayment as backendVerify } from '../src/services/payment-verification';
import stellarService from '../src/services/stellar.service';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service';
import { MemoryStorage } from '../src/storage/memory-storage';

// Frontend plain JS module
const frontendVerification = require('../../frontend/lib/verification.js');

interface VerificationFixture {
  id: string;
  description: string;
  input: {
    txHash: string;
    network?: string;
    expected: {
      memo: string;
      amount: string | number;
      destination: string;
      assetCode: string;
      assetIssuer?: string;
      network?: string;
    };
    transaction: {
      memo?: string;
      memo_type?: string;
    };
    operations: Array<{
      type: string;
      from?: string;
      to?: string;
      amount?: string;
      asset_type?: string;
      asset_code?: string;
      asset_issuer?: string;
    }>;
  };
  expectedOutcome: {
    ok: boolean;
    code: string | null;
    error: string | null;
  };
}

const fixturesPath = path.resolve(__dirname, '../../fixtures/verification-fixtures.json');
const fixtures: VerificationFixture[] = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return res;
}

describe('Verification Drift Detection — Four Call Sites (Issue #11)', () => {
  it('loads version-controlled fixtures covering happy path and failure stages', () => {
    assert.ok(Array.isArray(fixtures));
    assert.ok(fixtures.length >= 10, `Expected >= 10 fixtures, got ${fixtures.length}`);
  });

  for (const fixture of fixtures) {
    it(`fixture [${fixture.id}]: asserts agreement across all 4 call sites — ${fixture.description}`, async () => {
      const { input, expectedOutcome } = fixture;

      // ----------------------------------------------------
      // Call Site 1: backend/src/services/payment-verification.ts
      // ----------------------------------------------------
      const res1 = backendVerify({
        txHash: input.txHash,
        expected: input.expected,
        transaction: input.transaction,
        operations: input.operations,
        network: input.network,
      });

      const site1Result = {
        ok: res1.ok,
        code: res1.ok ? null : res1.code,
        error: res1.ok ? null : res1.error,
      };

      // ----------------------------------------------------
      // Call Site 2: frontend/lib/verification.js
      // ----------------------------------------------------
      const res2 = frontendVerification.verifyHorizonPayment({
        txHash: input.txHash,
        expected: input.expected,
        transaction: input.transaction,
        operations: input.operations,
        network: input.network,
      });

      const site2Result = {
        ok: res2.ok,
        code: res2.ok ? null : res2.code,
        error: res2.ok ? null : res2.error,
      };

      // ----------------------------------------------------
      // Call Site 3: backend/src/services/stellar.service.ts
      // ----------------------------------------------------
      // Mock getTransaction to return the fixture transaction and operations
      stellarService.getTransaction = async () => ({
        transaction: input.transaction,
        operations: input.operations,
      });

      const res3 = await stellarService.verifyPayment(
        input.txHash,
        input.expected,
        input.network
      );

      const site3Result = {
        ok: res3.ok,
        code: res3.ok ? null : res3.code,
        error: res3.ok ? null : res3.error,
      };

      // ----------------------------------------------------
      // Call Site 4: backend/src/routes/invoice.handlers.ts
      // ----------------------------------------------------
      const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(new MemoryStorage()));
      const rawAmount =
        typeof input.expected.amount === 'string'
          ? parseFloat(input.expected.amount)
          : input.expected.amount;

      const invoice = await storage.createInvoice({
        amount: isNaN(rawAmount) ? 10 : rawAmount,
        assetCode: input.expected.assetCode,
        assetIssuer: input.expected.assetIssuer,
        sellerPublicKey: input.expected.destination,
        description: 'Drift test invoice',
      });
      // Ensure the invoice memo matches fixture expected memo
      (invoice as any).memo = input.expected.memo;

      const handlers = createInvoiceHandlers({
        storage,
        frontendUrl: 'http://localhost:3000',
        allowSimulate: false,
        stellar: {
          getTransaction: async () => ({
            transaction: input.transaction,
            operations: input.operations,
          }),
        },
      });

      const req: any = {
        params: { id: invoice.id },
        body: {
          txHash: input.txHash,
          network: input.network,
        },
      };
      const res = createMockResponse();

      await handlers.verifyPayment(req as Request, res as Response);

      const site4Result = {
        ok: res.statusCode === 200,
        code: res.statusCode === 200 ? null : res.body?.code || null,
        error: res.statusCode === 200 ? null : res.body?.error || null,
      };

      // ----------------------------------------------------
      // Diff assertions against expected outcome
      // ----------------------------------------------------
      assert.deepStrictEqual(
        site1Result,
        expectedOutcome,
        `[Call Site 1: payment-verification.ts] drifted on fixture [${fixture.id}]`
      );

      assert.deepStrictEqual(
        site2Result,
        expectedOutcome,
        `[Call Site 2: verification.js] drifted on fixture [${fixture.id}]`
      );

      assert.deepStrictEqual(
        site3Result,
        expectedOutcome,
        `[Call Site 3: stellar.service.ts] drifted on fixture [${fixture.id}]`
      );

      assert.deepStrictEqual(
        site4Result,
        expectedOutcome,
        `[Call Site 4: invoice.handlers.ts] drifted on fixture [${fixture.id}]`
      );

      // Direct cross-callsite consistency
      assert.deepStrictEqual(
        site1Result,
        site2Result,
        `Call site 1 and Call site 2 drifted on fixture [${fixture.id}]`
      );
      assert.deepStrictEqual(
        site1Result,
        site3Result,
        `Call site 1 and Call site 3 drifted on fixture [${fixture.id}]`
      );
      assert.deepStrictEqual(
        site1Result,
        site4Result,
        `Call site 1 and Call site 4 drifted on fixture [${fixture.id}]`
      );
    });
  }
});
