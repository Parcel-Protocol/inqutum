import { Router } from 'express';
import type { JobStore } from '../jobs/job-types';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { metrics } from '../observability/telemetry';
import { buildOpsHealthReport } from '../ops/ops-health';
import { requireAdmin } from './jobs.routes';
import {
  ImpersonationService,
  impersonationService,
  IMPERSONATION_PERMISSIONS,
  type ImpersonationPermission,
} from '../audit/impersonation';
import { stellarPublicKeySchema } from '../utils/validation';
import { simulatePolicyChange } from '../domain/policy-simulation';
import { loadPolicy } from '../domain/policy';
import { staleProjectionService } from '../ops/stale-projections.service';
import { defaultSearchIndex } from '../services/search-index.service';
import { SyntheticJourneyMonitor } from '../ops/synthetic-journey-monitor';
import { verifySnapshotRestore } from '../db/snapshot-restore-verification';
import {
  DEPENDENCY_MATRIX,
  runDependencyChecks,
  validateMatrix,
  type DependencyId,
  type DependencyProbe,
} from '../ops/dependency-degradation';
import {
  PartialFailureRetryCoordinator,
  buildDashboard,
  inspectJobFailure,
  parseDashboardFilter,
} from '../ops/partial-failure-dashboard';
import { jobsToOperations } from '../domain/partial-failures';
import { ApprovalError, MaintainerApprovalService, type IntentStatus, type ReceiptOutcome } from '../ops/maintainer-approval';
import { auditStore } from '../audit/audit-service';

export interface OpsRouterOptions {
  storage: InvoiceStorage;
  jobs?: JobStore;
  /** Same bearer token as /jobs (JOBS_ADMIN_TOKEN). When empty, the route is disabled (403). */
  adminToken?: string;
  /** Overridable for tests. */
  impersonation?: ImpersonationService;
  /** Health probes per external dependency. Missing probes report `unknown`. */
  dependencyProbes?: Partial<Record<DependencyId, DependencyProbe>>;
  /**
   * Approval service for high-impact actions. Defaults to one keyed by
   * MAINTAINER_INTENT_SECRET; when that is unset the intent routes return 403.
   */
  approvals?: MaintainerApprovalService | null;
}

function defaultApprovals(): MaintainerApprovalService | null {
  const secret = process.env.MAINTAINER_INTENT_SECRET;
  if (!secret || secret.length < 16) return null;
  return new MaintainerApprovalService({
    secret,
    onReceipt: (r) =>
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: r.executedBy ?? r.requestedBy },
        scope: { entityType: 'system', entityId: r.target },
        reason: `${r.action}: ${r.outcome}`,
        metadata: {
          receiptId: r.id,
          intentId: r.intentId,
          outcome: r.outcome,
          approvedBy: r.approvedBy,
          riskScore: r.risk?.score ?? null,
          riskLevel: r.risk?.level ?? null,
          riskFactors: r.risk?.factors.map((f) => f.code) ?? [],
        },
      }),
  });
}

const durationOf = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Mount under `/api`.
 *   GET  /ops/health  maintainer summary of unresolved failures and drift
 *
 *   POST /ops/impersonation           start a scoped, time-limited session
 *   POST /ops/impersonation/end       close a session
 *   GET  /ops/impersonation           list sessions / read the banner state
 */
export function createOpsRouter(options: OpsRouterOptions): Router {
  const router = Router();
  const impersonation = options.impersonation ?? impersonationService;
  const admin = requireAdmin(options.adminToken);
  const approvals = options.approvals === undefined ? defaultApprovals() : options.approvals;
  const retries = options.jobs ? new PartialFailureRetryCoordinator(options.jobs) : null;

  if (approvals && options.jobs) {
    const jobs = options.jobs;
    approvals.registerExecutor('job.requeue_dead', async (intent) => {
      const job = await jobs.requeueDead(intent.target, new Date());
      if (!job) throw new Error('Job is not dead-lettered (state changed since intent was declared)');
      return { jobId: job.id, status: job.status };
    });
  }
  if (approvals) {
    approvals.registerExecutor('invoice.cancel', async (intent) => {
      const expected = typeof intent.params.expectedVersion === 'number' ? intent.params.expectedVersion : undefined;
      const invoice = await options.storage.cancelInvoice(intent.target, expected);
      return { invoiceId: invoice.id, status: invoice.status, version: invoice.version ?? null };
    });
  }

  const fail = (res: any, req: any, status: number, code: string, error: string) =>
    res.status(status).json({ success: false, code, error, correlationId: req.correlationId });

  // -- External dependency degradation matrix --------------------------------

  router.get('/ops/dependencies/matrix', admin, (req, res) => {
    res.json({
      success: true,
      data: { matrix: DEPENDENCY_MATRIX.map((d) => ({ ...d, failureModes: d.failureModes.map((f) => ({ code: f.code, description: f.description })) })), problems: validateMatrix() },
      correlationId: req.correlationId,
    });
  });

  router.get('/ops/dependencies', admin, async (req, res, next) => {
    try {
      const report = await runDependencyChecks(options.dependencyProbes ?? {});
      res.status(report.overall === 'down' ? 503 : 200).json({ success: report.overall !== 'down', data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Partial-failure dashboard ---------------------------------------------

  router.get('/ops/partial-failures', admin, async (req, res, next) => {
    try {
      const { filter, error } = parseDashboardFilter(req.query as Record<string, unknown>);
      if (error) return fail(res, req, 400, 'INVALID_FILTER', error);
      const jobs = options.jobs ? (await options.jobs.list({ limit: 1000 })).jobs : [];
      res.json({ success: true, data: buildDashboard(jobsToOperations(jobs), filter), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/ops/partial-failures/:id', admin, async (req, res, next) => {
    try {
      const job = options.jobs ? await options.jobs.get(req.params.id) : null;
      if (!job) return fail(res, req, 404, 'NOT_FOUND', 'Operation not found');
      res.json({ success: true, data: inspectJobFailure(job), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/partial-failures/:id/retry', admin, async (req, res, next) => {
    try {
      if (!retries) return fail(res, req, 503, 'JOBS_UNAVAILABLE', 'Job store not configured');
      const key = req.header('idempotency-key') ?? (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined);
      const outcome = await retries.retry(req.params.id, key);
      if (outcome.status === 'rejected') {
        const status = outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'USER_ACTION_REQUIRED' ? 422 : 409;
        return fail(res, req, status, outcome.code, outcome.message);
      }
      if (outcome.status === 'requeued') {
        auditStore.recordEvent({
          action: 'MAINTAINER_ACTION',
          actor: { type: 'maintainer', id: 'ops-admin' },
          scope: { entityType: 'system', entityId: outcome.job.id },
          reason: 'Partial failure retried from dashboard',
          metadata: { jobType: outcome.job.type, idempotencyKey: key ?? null },
          correlationId: req.correlationId,
        });
      }
      res.json({ success: true, data: { status: outcome.status, job: outcome.job }, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Maintainer action approvals with signed intent receipts ---------------

  const needApprovals = (req: any, res: any, next: any) =>
    approvals ? next() : fail(res, req, 403, 'APPROVALS_DISABLED', 'Set MAINTAINER_INTENT_SECRET to enable high-impact actions');
  const approvalError = (req: any, res: any, err: unknown, next: any) =>
    err instanceof ApprovalError ? fail(res, req, err.httpStatus, err.code, err.message) : next(err);

  router.post('/ops/intents', admin, needApprovals, (req, res, next) => {
    try {
      const intent = approvals!.requestIntent({
        action: String(req.body?.action ?? ''),
        target: String(req.body?.target ?? ''),
        reason: String(req.body?.reason ?? ''),
        requestedBy: String(req.body?.requestedBy ?? ''),
        params: req.body?.params && typeof req.body.params === 'object' ? req.body.params : {},
      });
      res.status(201).json({ success: true, data: intent, correlationId: req.correlationId });
    } catch (err) {
      approvalError(req, res, err, next);
    }
  });

  router.get('/ops/intents', admin, needApprovals, (req, res) => {
    const status = typeof req.query.status === 'string' ? (req.query.status as IntentStatus) : undefined;
    res.json({ success: true, data: approvals!.listIntents({ status }), correlationId: req.correlationId });
  });

  router.post('/ops/intents/:id/approve', admin, needApprovals, (req, res, next) => {
    try {
      res.json({ success: true, data: approvals!.approve(req.params.id, String(req.body?.approverId ?? '')), correlationId: req.correlationId });
    } catch (err) {
      approvalError(req, res, err, next);
    }
  });

  router.post('/ops/intents/:id/reject', admin, needApprovals, (req, res, next) => {
    try {
      res.json({ success: true, data: approvals!.reject(req.params.id, String(req.body?.maintainerId ?? ''), String(req.body?.reason ?? '')), correlationId: req.correlationId });
    } catch (err) {
      approvalError(req, res, err, next);
    }
  });

  router.post('/ops/intents/:id/execute', admin, needApprovals, async (req, res, next) => {
    try {
      const receipt = await approvals!.execute(req.params.id, {
        executedBy: String(req.body?.executedBy ?? ''),
        confirmation: String(req.body?.confirmation ?? ''),
        params: req.body?.params,
      });
      res.status(receipt.outcome === 'succeeded' ? 200 : 502).json({ success: receipt.outcome === 'succeeded', data: receipt, correlationId: req.correlationId });
    } catch (err) {
      approvalError(req, res, err, next);
    }
  });

  router.get('/ops/receipts', admin, needApprovals, (req, res) => {
    const outcome = typeof req.query.outcome === 'string' ? (req.query.outcome as ReceiptOutcome) : undefined;
    const target = typeof req.query.target === 'string' ? req.query.target : undefined;
    res.json({
      success: true,
      data: { receipts: approvals!.listReceipts({ outcome, target }), chainBrokenAt: approvals!.verifyReceiptChain() },
      correlationId: req.correlationId,
    });
  });

  router.get('/ops/receipts/:id', admin, needApprovals, (req, res) => {
    const receipt = approvals!.getReceipt(req.params.id);
    if (!receipt) return fail(res, req, 404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
    res.json({ success: true, data: { receipt, signatureValid: approvals!.verifyReceipt(receipt) }, correlationId: req.correlationId });
  });

  router.get('/ops/health', admin, async (req, res, next) => {
    try {
      const report = await buildOpsHealthReport({
        storage: options.storage,
        jobs: options.jobs,
        recentLogs: () => metrics.getRecentLogs(200),
      });
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Policy simulation preview before committing changes (Issue #267)
  router.post('/ops/policy/simulate', admin, async (req, res, next) => {
    try {
      const invoices = options.storage.getAllInvoices ? await options.storage.getAllInvoices() : [];
      const current = loadPolicy();
      const simulation = simulatePolicyChange(invoices, req.body?.proposedPolicy || {}, current);
      res.json({ success: true, data: simulation, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Stale projection detection and repair recommendations (Issue #269)
  router.get('/ops/stale-projections/detect', admin, async (req, res, next) => {
    try {
      const report = await staleProjectionService.detect(options.storage);
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/stale-projections/repair', admin, async (req, res, next) => {
    try {
      const mode = req.body?.mode === 'queued' ? 'queued' : 'immediate';
      const evidence = await staleProjectionService.repair(options.storage, defaultSearchIndex, { mode });
      res.json({ success: true, data: evidence, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Synthetic journey monitor for critical workflow (Issue #264)
  router.post('/ops/synthetic-journey/run', admin, async (req, res, next) => {
    try {
      const monitor = new SyntheticJourneyMonitor({ storage: options.storage });
      const report = await monitor.runJourney();
      res.status(report.success ? 200 : 503).json({ success: report.success, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Snapshot restore verification for critical data and derived indexes (Issue #263)
  router.post('/ops/snapshot-restore/verify', admin, async (req, res, next) => {
    try {
      const snapshotPkg = req.body?.snapshotPackage || {
        invoices: options.storage.getAllInvoices ? await options.storage.getAllInvoices() : [],
        metadata: { exportedAt: new Date().toISOString(), source: 'api' },
      };
      const report = verifySnapshotRestore(snapshotPkg);
      res.status(report.ok ? 200 : 422).json({ success: report.ok, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Scoped maintainer impersonation (#76) --------------------------------

  router.get('/ops/impersonation', admin, (req, res) => {
    const maintainerId = String(req.query.maintainerId ?? '');
    const includeClosed = req.query.includeClosed !== 'false';
    res.json({
      success: true,
      data: {
        indicator: maintainerId
          ? impersonation.indicator(maintainerId)
          : { active: false },
        sessions: impersonation.listSessions(includeClosed),
        permissions: IMPERSONATION_PERMISSIONS,
      },
      correlationId: req.correlationId,
    });
  });

  router.post('/ops/impersonation', admin, (req, res) => {
    const target = stellarPublicKeySchema.safeParse(req.body?.targetId);
    if (!target.success) {
      return res.status(400).json({
        success: false,
        code: 'TARGET_INVALID',
        error: 'targetId must be a valid Stellar public key',
        correlationId: req.correlationId,
      });
    }

    const permissions = (req.body?.permissions ?? ['read']) as ImpersonationPermission[];

    try {
      const session = impersonation.startSession({
        maintainerId: String(req.body?.maintainerId ?? ''),
        targetId: target.data,
        permissions,
        reason: String(req.body?.reason ?? ''),
        durationMs: durationOf(req.body?.durationMs),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      return res.status(201).json({
        success: true,
        data: { session, indicator: impersonation.indicator(session.maintainerId) },
        correlationId: req.correlationId,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        code: 'IMPERSONATION_REJECTED',
        error: err instanceof Error ? err.message : 'Impersonation session rejected',
        correlationId: req.correlationId,
      });
    }
  });

  router.post('/ops/impersonation/end', admin, (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const closed = impersonation.endSession(
      sessionId,
      req.body?.maintainerId ? String(req.body.maintainerId) : undefined,
    );
    if (!closed) {
      return res.status(404).json({
        success: false,
        code: 'SESSION_NOT_FOUND',
        error: 'No active session with that id for this maintainer',
        correlationId: req.correlationId,
      });
    }
    return res.json({ success: true, data: { sessionId, closed: true }, correlationId: req.correlationId });
  });

  return router;
}

export default createOpsRouter;
