import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  simulatePolicyChange,
  buildProposedPolicy,
  runMaintainerPolicySimulation,
  validateSimulationPolicyInput,
  PolicySimulationPermissionError,
  PolicySimulationValidationError,
} from '../src/domain/policy-simulation.ts';
import { DEFAULT_POLICY, type BusinessPolicy } from '../src/domain/policy.ts';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';
import type { Job } from '../src/jobs/job-types.ts';

const SELLER_1 = 'G' + '1'.repeat(55);
const SELLER_2 = 'G' + '2'.repeat(55);
const MAINTAINER = { id: 'maint-1', role: 'maintainer' as const };

function makeInvoice(id: string, over: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id,
    sellerPublicKey: SELLER_1,
    amount: 100,
    assetCode: 'XLM',
    memo: `INV-${id}`,
    status: 'PENDING',
    createdAt: new Date('2026-10-17T12:00:00.000Z'),
    expiresAt: new Date('2026-10-24T12:00:00.000Z'),
    ...over,
  };
}

function makeWorkflow(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    type: 'payment.verify',
    payload: { version: 1, data: { invoiceId: 'inv-high-1' } },
    status: 'queued',
    attempts: 3,
    retryPolicy: { maxAttempts: 5, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
    runAt: '2026-10-18T12:00:00.000Z',
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: null,
    correlationId: null,
    errors: [],
    result: null,
    createdAt: '2026-10-18T12:00:00.000Z',
    updatedAt: '2026-10-18T12:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

describe('Policy simulation preview contract & Maintainer Policy Simulation Tool', () => {
  it('previews zero affected records and risk NONE when proposed policy creates no divergence (no-impact)', () => {
    const invoices = [
      makeInvoice('inv-1', { amount: 100, assetCode: 'XLM', status: 'PENDING' }),
      makeInvoice('inv-2', { amount: 500, assetCode: 'XLM', status: 'PAID' }),
    ];

    const current: BusinessPolicy = {
      ...DEFAULT_POLICY,
      invoice: { ...DEFAULT_POLICY.invoice, minAmount: 1, maxAmount: 1000 },
    };

    const result = runMaintainerPolicySimulation({
      actor: MAINTAINER,
      currentPolicy: current,
      proposedPolicy: { minAmount: 0.5, maxAmount: 2000 },
      invoices,
      workflows: [makeWorkflow('wf-ok', { attempts: 1, payload: { version: 1, data: { invoiceId: 'inv-1' } } })],
    });

    assert.equal(result.riskLevel, 'NONE');
    assert.equal(result.totalAffectedRecords, 0);
    assert.equal(result.totalAffectedSellers, 0);
    assert.equal(result.counts.recordsAffected, 0);
    assert.equal(result.counts.activeWorkflowsAffected, 0);
    assert.equal(result.expectedSideEffects.pendingInvoicesAtRisk, 0);
    assert.equal(result.readOnlyVerified, true);
    assert.equal(result.riskWarnings.length, 0);
  });

  it('reports affected counts, examples, active workflows, and risk warnings for broad-impact changes', () => {
    const invoices = [
      makeInvoice('inv-low', { amount: 50, sellerPublicKey: SELLER_1, status: 'PENDING' }),
      makeInvoice('inv-high-1', { amount: 600, sellerPublicKey: SELLER_1, status: 'PENDING' }),
      makeInvoice('inv-high-2', { amount: 800, sellerPublicKey: SELLER_2, status: 'PENDING' }),
      makeInvoice('inv-paid', { amount: 900, sellerPublicKey: SELLER_2, status: 'PAID' }),
    ];
    const workflows = [
      makeWorkflow('wf-1', { attempts: 1, payload: { version: 1, data: { invoiceId: 'inv-high-1' } } }),
      makeWorkflow('wf-2', { attempts: 4, payload: { version: 1, data: { invoiceId: 'inv-low' } } }),
    ];

    const current: BusinessPolicy = {
      ...DEFAULT_POLICY,
      invoice: { ...DEFAULT_POLICY.invoice, maxAmount: 1000 },
    };

    const result = runMaintainerPolicySimulation({
      actor: MAINTAINER,
      currentPolicy: current,
      proposedPolicy: { maxAmount: 500, maxRetryAttempts: 2 },
      invoices,
      workflows,
      maxExamples: 2,
    });

    assert.equal(result.counts.recordsEvaluated, 4);
    assert.equal(result.counts.recordsAffected, 3);
    assert.equal(result.counts.pendingRecordsAtRisk, 2);
    assert.equal(result.counts.usersEvaluated, 2);
    assert.equal(result.counts.usersAffected, 2);
    assert.equal(result.counts.activeWorkflowsEvaluated, 2);
    assert.equal(result.counts.activeWorkflowsAffected, 2);

    assert.equal(result.outcomesByCode.AMOUNT_TOO_HIGH, 3);
    assert.equal(result.outcomesByCode.INVOICE_POLICY_DENIED, 1);
    assert.equal(result.outcomesByCode.WORKFLOW_RETRY_CAP_EXCEEDED, 1);

    assert.equal(result.examples.affectedRecords.length, 2);
    assert.equal(result.examples.affectedWorkflows.length, 2);
    assert.ok(result.riskWarnings.some((w) => w.code === 'MAX_AMOUNT_LOWERED'));
    assert.ok(result.riskWarnings.some((w) => w.code === 'ACTIVE_WORKFLOWS_IMPACTED'));

    // Also test high-volume built-in fixture for CRITICAL risk
    const criticalResult = runMaintainerPolicySimulation({
      actor: MAINTAINER,
      fixtureName: 'high-volume',
      proposedPolicy: { maxAmount: 10 },
    });
    assert.equal(criticalResult.sourceMode, 'fixture');
    assert.equal(criticalResult.riskLevel, 'CRITICAL');
    assert.ok(criticalResult.counts.pendingRecordsAtRisk > 50);
  });

  it('supports simulating against selected records without mutating production data', () => {
    const origInvoices = [
      Object.freeze(makeInvoice('sel-1', { amount: 500, sellerPublicKey: SELLER_1 })),
      Object.freeze(makeInvoice('sel-2', { amount: 700, sellerPublicKey: SELLER_2 })),
    ];

    const result = runMaintainerPolicySimulation({
      actor: MAINTAINER,
      proposedPolicy: { maxAmount: 200 },
      invoices: origInvoices,
      selection: { sellerPublicKeys: [SELLER_1] },
    });

    assert.equal(result.sourceMode, 'selected_records');
    assert.equal(result.counts.recordsEvaluated, 1);
    assert.equal(result.counts.recordsAffected, 1);
    assert.equal(result.examples.affectedRecords[0].invoiceId, 'sel-1');
    assert.equal(result.readOnlyVerified, true);
    assert.ok(result.inputDigestHex.length === 64);
    assert.equal(origInvoices[0].amount, 500);
    assert.equal(origInvoices[1].amount, 700);
  });

  it('rejects invalid policy inputs with PolicySimulationValidationError', () => {
    const invalidInputs: unknown[] = [
      null,
      undefined,
      'not-an-object',
      [],
      {},
      { unknownPolicyKnob: 123 },
      { maxAmount: -10 },
      { minAmount: 5000, maxAmount: 100 },
      { minExpiryDays: 20, maxExpiryDays: 5 },
      { allowedAssets: ['INVALID_ASSET_CODE_TOO_LONG_12345'] },
      { maxRetryAttempts: 0 },
    ];

    for (const proposedPolicy of invalidInputs) {
      assert.throws(
        () => validateSimulationPolicyInput(proposedPolicy, DEFAULT_POLICY),
        (err: unknown) =>
          err instanceof PolicySimulationValidationError &&
          err.code === 'INVALID_POLICY_PROPOSAL' &&
          err.httpStatus === 400
      );
    }
  });

  it('denies simulation to non-maintainer roles (permission-denied simulation)', () => {
    for (const badActor of [
      { id: 'u1', role: 'seller' },
      { id: 'u2', role: 'payer' },
      { id: 'u3', role: 'anonymous' },
      { id: '', role: 'maintainer' },
    ]) {
      assert.throws(
        () =>
          runMaintainerPolicySimulation({
            actor: badActor,
            proposedPolicy: { maxAmount: 500 },
            invoices: [],
          }),
        (err: unknown) =>
          err instanceof PolicySimulationPermissionError &&
          err.code === 'POLICY_SIMULATION_FORBIDDEN' &&
          err.httpStatus === 403
      );
    }
  });

  it('maintains backward compatibility with simulatePolicyChange and buildProposedPolicy', () => {
    const inv = makeInvoice('compat-1', { amount: 250, assetCode: 'USDC' });
    const sim = simulatePolicyChange([inv], { allowedAssets: ['XLM'] }, DEFAULT_POLICY);
    assert.equal(sim.totalAffectedRecords, 1);
    assert.equal(sim.expectedSideEffects.volumeAtRiskByAsset.USDC, 250);
    assert.equal(buildProposedPolicy(DEFAULT_POLICY, { maxAmount: 999 }).invoice.maxAmount, 999);
  });
});
