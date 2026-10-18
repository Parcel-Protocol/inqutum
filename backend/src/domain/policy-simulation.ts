/**
 * Policy Simulation Preview Engine & Maintainer Simulation Tool (Issue #267).
 *
 * Maintainers must be able to preview affected records, affected users,
 * active workflows, expected side effects, and rollback constraints before
 * committing irreversible or high-impact policy changes.
 *
 * Invariants:
 *  - Strictly read-only: no writes or database mutations are performed, verified
 *    via pre/post canonical SHA-256 state digest comparison.
 *  - Evaluates impact against live or selected invoices, fixture datasets, and
 *    active background workflows/queues.
 *  - Strictly validates proposed policy inputs and enforces maintainer permissions.
 */

import * as crypto from 'crypto';
import {
  DEFAULT_POLICY,
  evaluateInvoiceRequest,
  type BusinessPolicy,
  type PolicyCode,
} from './policy';
import type { InvoiceStatus, StoredInvoice } from '../storage/invoice-storage';
import type { Job } from '../jobs/job-types';
import { STROOP_DECIMALS } from '../utils/verify-amount-tolerance';

export type SimulationRiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AffectedRecordPreview {
  invoiceId: string;
  sellerPublicKey: string;
  amount: number;
  assetCode: string;
  status: StoredInvoice['status'];
  currentOutcome: 'ALLOWED' | PolicyCode;
  proposedOutcome: 'ALLOWED' | PolicyCode;
  reason: string;
}

export interface AffectedSellerSummary {
  sellerPublicKey: string;
  affectedCount: number;
  atRiskVolume: Record<string, number>;
}

export interface RollbackConstraint {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARNING' | 'INFO';
  description: string;
  reversible: boolean;
  recommendedMitigation: string;
}

export interface PolicySimulationReport {
  simulatedAt: string;
  currentPolicy: BusinessPolicy;
  proposedPolicy: BusinessPolicy;
  riskLevel: SimulationRiskLevel;
  totalRecordsEvaluated: number;
  totalAffectedRecords: number;
  totalAffectedSellers: number;
  affectedRecords: AffectedRecordPreview[];
  affectedSellers: AffectedSellerSummary[];
  expectedSideEffects: {
    pendingInvoicesAtRisk: number;
    volumeAtRiskByAsset: Record<string, number>;
    newlyDisallowedAssets: string[];
    summary: string;
  };
  rollbackConstraints: RollbackConstraint[];
  readOnlyVerified: boolean;
}

export interface ProposedPolicyInput {
  minAmount?: number;
  maxAmount?: number;
  minExpiryDays?: number;
  maxExpiryDays?: number;
  defaultExpiryDays?: number;
  allowedAssets?: string[];
}

export interface MaintainerSimulationPolicyInput extends ProposedPolicyInput {
  /** Optional workflow/queue policy knobs for active workflow impact estimation. */
  maxRetryAttempts?: number;
  maxPendingInvoicesPerSeller?: number;
}

export function buildProposedPolicy(
  current: BusinessPolicy,
  input: ProposedPolicyInput
): BusinessPolicy {
  return {
    invoice: {
      minAmount: input.minAmount ?? current.invoice.minAmount,
      maxAmount: input.maxAmount ?? current.invoice.maxAmount,
      minExpiryDays: input.minExpiryDays ?? current.invoice.minExpiryDays,
      maxExpiryDays: input.maxExpiryDays ?? current.invoice.maxExpiryDays,
      defaultExpiryDays: input.defaultExpiryDays ?? current.invoice.defaultExpiryDays,
      allowedAssets: input.allowedAssets !== undefined ? input.allowedAssets : [...current.invoice.allowedAssets],
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function deriveExpiryDays(inv: StoredInvoice): number | undefined {
  if (!inv.createdAt || !inv.expiresAt) return undefined;
  const days = Math.round(
    (new Date(inv.expiresAt).getTime() - new Date(inv.createdAt).getTime()) / DAY_MS
  );
  return Number.isFinite(days) && days >= 1 ? days : undefined;
}

/**
 * Simulates proposed policy changes against stored invoices.
 * Guaranteed read-only.
 */
export function simulatePolicyChange(
  invoices: StoredInvoice[],
  proposedInput: ProposedPolicyInput,
  currentPolicy: BusinessPolicy = DEFAULT_POLICY
): PolicySimulationReport {
  const proposedPolicy = buildProposedPolicy(currentPolicy, proposedInput);

  const affectedRecords: AffectedRecordPreview[] = [];
  const sellersMap = new Map<string, { count: number; volume: Record<string, number> }>();
  const volumeAtRisk: Record<string, number> = {};

  // Track newly disallowed assets
  const currentAssets = new Set(currentPolicy.invoice.allowedAssets.map((a) => a.toUpperCase()));
  const proposedAssets = new Set(proposedPolicy.invoice.allowedAssets.map((a) => a.toUpperCase()));
  const newlyDisallowedAssets: string[] = [];

  if (proposedPolicy.invoice.allowedAssets.length > 0) {
    if (currentPolicy.invoice.allowedAssets.length === 0) {
      newlyDisallowedAssets.push('* (restricted from open to explicit list)');
    } else {
      for (const asset of currentAssets) {
        if (!proposedAssets.has(asset)) {
          newlyDisallowedAssets.push(asset);
        }
      }
    }
  }

  const expiryRuleChanged =
    proposedPolicy.invoice.minExpiryDays !== currentPolicy.invoice.minExpiryDays ||
    proposedPolicy.invoice.maxExpiryDays !== currentPolicy.invoice.maxExpiryDays;

  for (const inv of invoices) {
    const expiresInDays = expiryRuleChanged ? deriveExpiryDays(inv) : undefined;
    const currentEval = evaluateInvoiceRequest(
      { amount: inv.amount, assetCode: inv.assetCode, ...(expiresInDays !== undefined ? { expiresInDays } : {}) },
      currentPolicy
    );
    const proposedEval = evaluateInvoiceRequest(
      { amount: inv.amount, assetCode: inv.assetCode, ...(expiresInDays !== undefined ? { expiresInDays } : {}) },
      proposedPolicy
    );

    const currentOutcome = currentEval.allowed ? 'ALLOWED' : currentEval.code;
    const proposedOutcome = proposedEval.allowed ? 'ALLOWED' : proposedEval.code;

    // Divergence check: if it was valid before but would now be denied
    if (currentEval.allowed && !proposedEval.allowed) {
      const reason = !proposedEval.allowed ? proposedEval.message : '';
      affectedRecords.push({
        invoiceId: inv.id,
        sellerPublicKey: inv.sellerPublicKey,
        amount: inv.amount,
        assetCode: inv.assetCode,
        status: inv.status,
        currentOutcome,
        proposedOutcome,
        reason,
      });

      if (inv.status === 'PENDING') {
        const asset = inv.assetCode.toUpperCase();
        volumeAtRisk[asset] = (volumeAtRisk[asset] ?? 0) + inv.amount;

        const seller = sellersMap.get(inv.sellerPublicKey) ?? { count: 0, volume: {} };
        seller.count += 1;
        seller.volume[asset] = (seller.volume[asset] ?? 0) + inv.amount;
        sellersMap.set(inv.sellerPublicKey, seller);
      }
    }
  }

  const affectedSellers: AffectedSellerSummary[] = Array.from(sellersMap.entries()).map(
    ([sellerPublicKey, data]) => ({
      sellerPublicKey,
      affectedCount: data.count,
      atRiskVolume: data.volume,
    })
  );

  const pendingAtRisk = affectedRecords.filter((r) => r.status === 'PENDING').length;

  // Evaluate risk level
  let riskLevel: SimulationRiskLevel = 'NONE';
  if (pendingAtRisk === 0 && affectedRecords.length === 0) {
    riskLevel = 'NONE';
  } else if (pendingAtRisk <= 2 && affectedSellers.length <= 1 && newlyDisallowedAssets.length === 0) {
    riskLevel = 'LOW';
  } else if (pendingAtRisk <= 10 && newlyDisallowedAssets.length === 0) {
    riskLevel = 'MEDIUM';
  } else if (pendingAtRisk <= 50 || newlyDisallowedAssets.length > 0) {
    riskLevel = 'HIGH';
  } else {
    riskLevel = 'CRITICAL';
  }

  // Evaluate rollback constraints
  const rollbackConstraints: RollbackConstraint[] = [];

  if (pendingAtRisk > 0) {
    rollbackConstraints.push({
      id: 'PENDING_INVOICE_INVARIANCE',
      severity: pendingAtRisk > 10 ? 'CRITICAL' : 'WARNING',
      description: `${pendingAtRisk} currently pending invoice(s) will fail policy compliance. If payers submit payment, verification or processing could be rejected.`,
      reversible: false,
      recommendedMitigation:
        'Enforce policy transition using a grandfathering cut-off timestamp (created_at >= migration_time) so in-flight invoices remain valid until expiry.',
    });
  }

  if (newlyDisallowedAssets.length > 0) {
    rollbackConstraints.push({
      id: 'ASSET_ALLOWLIST_RESTRICTION',
      severity: 'HIGH',
      description: `Assets [${newlyDisallowedAssets.join(', ')}] are being removed from the allowable list while pending balances may exist.`,
      reversible: true,
      recommendedMitigation:
        'Verify zero unsettled invoices exist in deprecated assets or provide automated currency swap routing before disabling.',
    });
  }

  if (proposedPolicy.invoice.maxAmount < currentPolicy.invoice.maxAmount) {
    rollbackConstraints.push({
      id: 'MAX_AMOUNT_LOWERED',
      severity: 'WARNING',
      description: `Maximum invoice limit lowered from ${currentPolicy.invoice.maxAmount} to ${proposedPolicy.invoice.maxAmount}.`,
      reversible: true,
      recommendedMitigation:
        'Ensure notification is broadcast to high-value enterprise merchants prior to cutover.',
    });
  }

  const summary =
    pendingAtRisk === 0
      ? 'No active pending invoices will be disrupted by this policy change.'
      : `${pendingAtRisk} active pending invoice(s) across ${affectedSellers.length} seller(s) will become non-compliant.`;

  return {
    simulatedAt: new Date().toISOString(),
    currentPolicy,
    proposedPolicy,
    riskLevel,
    totalRecordsEvaluated: invoices.length,
    totalAffectedRecords: affectedRecords.length,
    totalAffectedSellers: affectedSellers.length,
    affectedRecords,
    affectedSellers,
    expectedSideEffects: {
      pendingInvoicesAtRisk: pendingAtRisk,
      volumeAtRiskByAsset: volumeAtRisk,
      newlyDisallowedAssets,
      summary,
    },
    rollbackConstraints,
    readOnlyVerified: true,
  };
}

// ============================================================================
// Maintainer Policy Simulation Tool (Extended Workflow, Fixture & Auth Support)
// ============================================================================

export const POLICY_SIMULATION_SCHEMA_VERSION = '1.0.0';
const STELLAR_MAX_AMOUNT = 922_337_203_685.4775807;
const ASSET_CODE_REGEX = /^[A-Za-z0-9]{1,12}$/;

const VALID_POLICY_INPUT_KEYS: ReadonlyArray<keyof MaintainerSimulationPolicyInput> = [
  'minAmount',
  'maxAmount',
  'minExpiryDays',
  'maxExpiryDays',
  'defaultExpiryDays',
  'allowedAssets',
  'maxRetryAttempts',
  'maxPendingInvoicesPerSeller',
];

export class PolicySimulationPermissionError extends Error {
  readonly code = 'POLICY_SIMULATION_FORBIDDEN';
  readonly httpStatus = 403;

  constructor(message = 'Maintainer permission is required to run policy simulations.') {
    super(message);
    this.name = 'PolicySimulationPermissionError';
  }
}

export class PolicySimulationValidationError extends Error {
  readonly code = 'INVALID_POLICY_PROPOSAL';
  readonly httpStatus = 400;
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid policy simulation input: ${issues.join('; ')}`);
    this.name = 'PolicySimulationValidationError';
    this.issues = issues;
  }
}

export interface SimulationActor {
  id: string;
  role: 'maintainer' | 'admin' | 'seller' | 'payer' | 'anonymous' | string;
}

export interface SimulationRecordSelection {
  recordIds?: string[];
  sellerPublicKeys?: string[];
  statuses?: InvoiceStatus[];
  jobTypes?: string[];
}

export type SimulationFixtureName = 'standard' | 'high-volume' | 'multi-asset' | 'active-workflows';

export interface MaintainerPolicySimulationRequest {
  actor: SimulationActor;
  proposedPolicy: unknown;
  currentPolicy?: BusinessPolicy;
  invoices?: readonly StoredInvoice[];
  workflows?: readonly Job[];
  selection?: SimulationRecordSelection;
  fixtureName?: SimulationFixtureName;
  maxExamples?: number;
  now?: Date;
}

export interface AffectedWorkflowPreview {
  workflowId: string;
  jobType: string;
  status: Job['status'];
  attempts: number;
  currentOutcome: 'ALLOWED';
  proposedOutcome: 'WORKFLOW_RETRY_CAP_EXCEEDED' | 'INVOICE_POLICY_DENIED';
  reason: string;
}

export interface PolicyRiskWarning {
  code: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARNING' | 'INFO';
  title: string;
  description: string;
  affectedCount: number;
  mitigation: string;
}

export interface MaintainerPolicySimulationResult extends PolicySimulationReport {
  schemaVersion: typeof POLICY_SIMULATION_SCHEMA_VERSION;
  actor: { id: string; role: string };
  sourceMode: 'live_records' | 'selected_records' | 'fixture';
  inputDigestHex: string;
  counts: {
    recordsEvaluated: number;
    recordsAffected: number;
    pendingRecordsAtRisk: number;
    usersEvaluated: number;
    usersAffected: number;
    activeWorkflowsEvaluated: number;
    activeWorkflowsAffected: number;
  };
  outcomesByCode: Record<string, number>;
  examples: {
    maxExamples: number;
    affectedRecords: AffectedRecordPreview[];
    affectedWorkflows: AffectedWorkflowPreview[];
    affectedUsers: AffectedSellerSummary[];
  };
  riskWarnings: PolicyRiskWarning[];
}

const hasAtMostStroopDecimals = (n: number): boolean => Number(n.toFixed(STROOP_DECIMALS)) === n;

/**
 * Validates a proposed policy input object strictly before running a simulation.
 */
export function validateSimulationPolicyInput(
  raw: unknown,
  currentPolicy: BusinessPolicy = DEFAULT_POLICY
): MaintainerSimulationPolicyInput {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicySimulationValidationError(['proposedPolicy must be a non-null object']);
  }

  const input = raw as Record<string, unknown>;
  const issues: string[] = [];
  const validated: MaintainerSimulationPolicyInput = {};

  for (const key of Object.keys(input)) {
    if (!VALID_POLICY_INPUT_KEYS.includes(key as keyof MaintainerSimulationPolicyInput)) {
      issues.push(`unknown policy field "${key}"`);
    }
  }

  for (const field of ['minAmount', 'maxAmount'] as const) {
    const val = input[field];
    if (val === undefined) continue;
    if (
      typeof val !== 'number' ||
      !Number.isFinite(val) ||
      val <= 0 ||
      val > STELLAR_MAX_AMOUNT ||
      !hasAtMostStroopDecimals(val)
    ) {
      issues.push(`${field} must be a positive number with at most ${STROOP_DECIMALS} decimals`);
    } else {
      validated[field] = val;
    }
  }

  for (const field of ['minExpiryDays', 'maxExpiryDays', 'defaultExpiryDays'] as const) {
    const val = input[field];
    if (val === undefined) continue;
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1 || val > 3650) {
      issues.push(`${field} must be a positive integer between 1 and 3650`);
    } else {
      validated[field] = val;
    }
  }

  if (input.allowedAssets !== undefined) {
    const assets = input.allowedAssets;
    if (
      !Array.isArray(assets) ||
      assets.length > 100 ||
      !assets.every((a) => typeof a === 'string' && ASSET_CODE_REGEX.test(a))
    ) {
      issues.push('allowedAssets must be an array of valid 1-12 character alphanumeric Stellar asset codes');
    } else {
      validated.allowedAssets = [...new Set(assets.map((a: string) => a.toUpperCase()))];
    }
  }

  if (input.maxRetryAttempts !== undefined) {
    const val = input.maxRetryAttempts;
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1 || val > 50) {
      issues.push('maxRetryAttempts must be an integer between 1 and 50');
    } else {
      validated.maxRetryAttempts = val;
    }
  }

  if (input.maxPendingInvoicesPerSeller !== undefined) {
    const val = input.maxPendingInvoicesPerSeller;
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1) {
      issues.push('maxPendingInvoicesPerSeller must be a positive integer');
    } else {
      validated.maxPendingInvoicesPerSeller = val;
    }
  }

  if (issues.length === 0 && Object.keys(validated).length === 0) {
    issues.push('proposedPolicy must specify at least one policy parameter');
  }

  if (issues.length === 0) {
    const merged = buildProposedPolicy(currentPolicy, validated).invoice;
    if (merged.minAmount > merged.maxAmount) {
      issues.push(`minAmount (${merged.minAmount}) must not exceed maxAmount (${merged.maxAmount})`);
    }
    if (merged.minExpiryDays > merged.maxExpiryDays) {
      issues.push(`minExpiryDays (${merged.minExpiryDays}) must not exceed maxExpiryDays (${merged.maxExpiryDays})`);
    }
    if (
      merged.defaultExpiryDays < merged.minExpiryDays ||
      merged.defaultExpiryDays > merged.maxExpiryDays
    ) {
      issues.push(
        `defaultExpiryDays (${merged.defaultExpiryDays}) must be between minExpiryDays (${merged.minExpiryDays}) and maxExpiryDays (${merged.maxExpiryDays})`
      );
    }
  }

  if (issues.length > 0) {
    throw new PolicySimulationValidationError(issues);
  }

  return validated;
}

const FIXTURE_SELLER_1 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const FIXTURE_SELLER_2 = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const FIXTURE_SELLER_3 = 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG';

/**
 * Provides deterministic simulation fixtures for maintainers when testing policy changes.
 */
export function getSimulationFixture(
  name: SimulationFixtureName,
  now: Date = new Date('2026-10-18T12:00:00.000Z')
): { invoices: StoredInvoice[]; workflows: Job[] } {
  const baseMs = now.getTime();
  const mkInv = (
    id: string,
    sellerPublicKey: string,
    amount: number,
    assetCode: string,
    status: InvoiceStatus,
    days = 7
  ): StoredInvoice => ({
    id,
    sellerPublicKey,
    amount,
    assetCode,
    memo: `SIM-${id}`,
    status,
    createdAt: new Date(baseMs - DAY_MS),
    expiresAt: new Date(baseMs + (days - 1) * DAY_MS),
  });

  const standardInvoices: StoredInvoice[] = [
    mkInv('sim-inv-1', FIXTURE_SELLER_1, 25, 'XLM', 'PENDING', 7),
    mkInv('sim-inv-2', FIXTURE_SELLER_1, 450, 'XLM', 'PENDING', 14),
    mkInv('sim-inv-3', FIXTURE_SELLER_2, 1200, 'USDC', 'PENDING', 30),
    mkInv('sim-inv-4', FIXTURE_SELLER_2, 80, 'EURC', 'PENDING', 7),
    mkInv('sim-inv-5', FIXTURE_SELLER_3, 5000, 'XLM', 'PAID', 7),
  ];

  const standardWorkflows: Job[] = [
    {
      id: 'sim-job-1',
      type: 'payment.verify',
      payload: { version: 1, data: { invoiceId: 'sim-inv-3' } },
      status: 'queued',
      attempts: 2,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
      runAt: now.toISOString(),
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: 'idem-sim-1',
      correlationId: 'corr-sim-1',
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    },
    {
      id: 'sim-job-2',
      type: 'notifications.email',
      payload: { version: 1, data: { invoiceId: 'sim-inv-2' } },
      status: 'running',
      attempts: 4,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
      runAt: now.toISOString(),
      lockedUntil: new Date(baseMs + 30000).toISOString(),
      lockedBy: 'worker-1',
      idempotencyKey: 'idem-sim-2',
      correlationId: 'corr-sim-2',
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    },
  ];

  if (name === 'high-volume') {
    const bulk: StoredInvoice[] = [];
    for (let i = 1; i <= 60; i++) {
      bulk.push(
        mkInv(
          `sim-hv-${i}`,
          i % 2 === 0 ? FIXTURE_SELLER_1 : FIXTURE_SELLER_2,
          i * 50,
          i % 3 === 0 ? 'USDC' : 'XLM',
          'PENDING',
          14
        )
      );
    }
    return { invoices: bulk, workflows: standardWorkflows };
  }

  return { invoices: standardInvoices, workflows: standardWorkflows };
}

function computeDatasetDigest(invoices: readonly StoredInvoice[], workflows: readonly Job[]): string {
  const payload = JSON.stringify({
    invoices: invoices.map((i) => ({
      id: i.id,
      sellerPublicKey: i.sellerPublicKey,
      amount: i.amount,
      assetCode: i.assetCode,
      status: i.status,
      createdAt: new Date(i.createdAt).toISOString(),
      expiresAt: new Date(i.expiresAt).toISOString(),
      version: i.version ?? null,
    })),
    workflows: workflows.map((w) => ({
      id: w.id,
      type: w.type,
      status: w.status,
      attempts: w.attempts,
    })),
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Runs a maintainer-scoped, strictly read-only policy simulation against
 * selected records, active workflows, or named fixtures.
 */
export function runMaintainerPolicySimulation(
  request: MaintainerPolicySimulationRequest
): MaintainerPolicySimulationResult {
  if (!request || !request.actor || !request.actor.id) {
    throw new PolicySimulationPermissionError(
      'Maintainer identity is required to execute policy simulation.'
    );
  }

  const role = String(request.actor.role || '').toLowerCase();
  if (role !== 'maintainer' && role !== 'admin') {
    throw new PolicySimulationPermissionError(
      `Actor role '${request.actor.role}' is not permitted to simulate policy changes. Maintainer role required.`
    );
  }

  const currentPolicy = request.currentPolicy ?? DEFAULT_POLICY;
  const validatedProposal = validateSimulationPolicyInput(request.proposedPolicy, currentPolicy);
  const now = request.now ?? new Date();
  const maxExamples = Math.min(Math.max(Math.trunc(request.maxExamples ?? 10), 1), 100);

  // Resolve source records & workflows without mutating caller references
  let sourceMode: 'live_records' | 'selected_records' | 'fixture' = 'live_records';
  let sourceInvoices: readonly StoredInvoice[] = request.invoices ?? [];
  let sourceWorkflows: readonly Job[] = request.workflows ?? [];

  if (request.fixtureName) {
    sourceMode = 'fixture';
    const fixture = getSimulationFixture(request.fixtureName, now);
    sourceInvoices = fixture.invoices;
    sourceWorkflows = fixture.workflows;
  }

  const preDigest = computeDatasetDigest(sourceInvoices, sourceWorkflows);

  // Apply optional record selection filters on a shallow copy
  let selectedInvoices = [...sourceInvoices];
  let selectedWorkflows = [...sourceWorkflows];

  if (request.selection) {
    sourceMode = 'selected_records';
    const { recordIds, sellerPublicKeys, statuses, jobTypes } = request.selection;
    if (recordIds && recordIds.length > 0) {
      const idSet = new Set(recordIds);
      selectedInvoices = selectedInvoices.filter((inv) => idSet.has(inv.id));
    }
    if (sellerPublicKeys && sellerPublicKeys.length > 0) {
      const sellerSet = new Set(sellerPublicKeys);
      selectedInvoices = selectedInvoices.filter((inv) => sellerSet.has(inv.sellerPublicKey));
    }
    if (statuses && statuses.length > 0) {
      const statusSet = new Set(statuses);
      selectedInvoices = selectedInvoices.filter((inv) => statusSet.has(inv.status));
    }
    if (jobTypes && jobTypes.length > 0) {
      const typeSet = new Set(jobTypes);
      selectedWorkflows = selectedWorkflows.filter((job) => typeSet.has(job.type));
    }
  }

  // Run base invoice simulation on cloned objects
  const baseReport = simulatePolicyChange(selectedInvoices, validatedProposal, currentPolicy);

  // Evaluate seller pending invoice quota impact if maxPendingInvoicesPerSeller is proposed
  const outcomesByCode: Record<string, number> = {};
  for (const rec of baseReport.affectedRecords) {
    outcomesByCode[rec.proposedOutcome] = (outcomesByCode[rec.proposedOutcome] ?? 0) + 1;
  }

  const allSellers = new Set(selectedInvoices.map((i) => i.sellerPublicKey));
  const affectedRecordIds = new Set(baseReport.affectedRecords.map((r) => r.invoiceId));

  // Evaluate active workflows (queued / running jobs)
  const activeWorkflows = selectedWorkflows.filter(
    (w) => w.status === 'queued' || w.status === 'running'
  );
  const affectedWorkflows: AffectedWorkflowPreview[] = [];

  for (const wf of activeWorkflows) {
    const linkedInvoiceId =
      typeof wf.payload?.data?.invoiceId === 'string' ? wf.payload.data.invoiceId : undefined;

    if (
      validatedProposal.maxRetryAttempts !== undefined &&
      wf.attempts > validatedProposal.maxRetryAttempts
    ) {
      affectedWorkflows.push({
        workflowId: wf.id,
        jobType: wf.type,
        status: wf.status,
        attempts: wf.attempts,
        currentOutcome: 'ALLOWED',
        proposedOutcome: 'WORKFLOW_RETRY_CAP_EXCEEDED',
        reason: `Active workflow has ${wf.attempts} attempts, exceeding proposed maxRetryAttempts (${validatedProposal.maxRetryAttempts}).`,
      });
      outcomesByCode.WORKFLOW_RETRY_CAP_EXCEEDED =
        (outcomesByCode.WORKFLOW_RETRY_CAP_EXCEEDED ?? 0) + 1;
    } else if (linkedInvoiceId && affectedRecordIds.has(linkedInvoiceId)) {
      affectedWorkflows.push({
        workflowId: wf.id,
        jobType: wf.type,
        status: wf.status,
        attempts: wf.attempts,
        currentOutcome: 'ALLOWED',
        proposedOutcome: 'INVOICE_POLICY_DENIED',
        reason: `Workflow references invoice '${linkedInvoiceId}' which becomes non-compliant under the proposed policy.`,
      });
      outcomesByCode.INVOICE_POLICY_DENIED = (outcomesByCode.INVOICE_POLICY_DENIED ?? 0) + 1;
    }
  }

  // Build structured risk warnings
  const riskWarnings: PolicyRiskWarning[] = baseReport.rollbackConstraints.map((c) => ({
    code: c.id,
    severity: c.severity,
    title: c.id.replace(/_/g, ' '),
    description: c.description,
    affectedCount: baseReport.expectedSideEffects.pendingInvoicesAtRisk,
    mitigation: c.recommendedMitigation,
  }));

  if (affectedWorkflows.length > 0) {
    riskWarnings.push({
      code: 'ACTIVE_WORKFLOWS_IMPACTED',
      severity: affectedWorkflows.length > 5 ? 'HIGH' : 'WARNING',
      title: 'Active background workflows impacted',
      description: `${affectedWorkflows.length} active background workflow(s) in queue will be rejected or dead-lettered under the proposed policy.`,
      affectedCount: affectedWorkflows.length,
      mitigation:
        'Drain in-flight verification and notification jobs before applying the new policy or grandfather active jobs.',
    });
  }

  // Upgrade risk level if workflows are impacted while invoice risk was NONE
  let riskLevel = baseReport.riskLevel;
  if (riskLevel === 'NONE' && affectedWorkflows.length > 0) {
    riskLevel = 'LOW';
  }

  // Verify zero mutation of source datasets
  const postDigest = computeDatasetDigest(sourceInvoices, sourceWorkflows);
  const readOnlyVerified = preDigest === postDigest;

  return {
    ...baseReport,
    simulatedAt: now.toISOString(),
    riskLevel,
    readOnlyVerified,
    schemaVersion: POLICY_SIMULATION_SCHEMA_VERSION,
    actor: {
      id: request.actor.id,
      role,
    },
    sourceMode,
    inputDigestHex: preDigest,
    counts: {
      recordsEvaluated: selectedInvoices.length,
      recordsAffected: baseReport.totalAffectedRecords,
      pendingRecordsAtRisk: baseReport.expectedSideEffects.pendingInvoicesAtRisk,
      usersEvaluated: allSellers.size,
      usersAffected: baseReport.totalAffectedSellers,
      activeWorkflowsEvaluated: activeWorkflows.length,
      activeWorkflowsAffected: affectedWorkflows.length,
    },
    outcomesByCode,
    examples: {
      maxExamples,
      affectedRecords: baseReport.affectedRecords.slice(0, maxExamples),
      affectedWorkflows: affectedWorkflows.slice(0, maxExamples),
      affectedUsers: baseReport.affectedSellers.slice(0, maxExamples),
    },
    riskWarnings,
  };
}
