/**
 * User-Safe Degraded Mode Service for Unavailable Dependencies.
 *
 * Architecture:
 *  - Evaluates external dependency health via active probes and error classification.
 *  - Maps dependency outages to user-safe capability fallbacks (defer, refuse, serve_stale).
 *  - Ensures the core invariant: a degraded dependency NEVER causes false positives
 *    (e.g., an invoice marked PAID without Stellar Horizon proof, or notification marked sent).
 *  - Supports manual operator overrides with audit logging for incident response & drills.
 *  - Provides Express middleware and error interceptors that attach Retry-After and X-Degraded-Mode headers.
 *
 * See docs/DEPENDENCY-DEGRADATION.md for runbook and operational details.
 */

import { Request, Response, NextFunction } from 'express';
import {
  DEPENDENCY_MATRIX,
  capabilityStatus,
  classifyFailure,
  evaluateDependency,
  runDependencyChecks,
  specFor,
  type Capability,
  type CapabilityDecision,
  type CapabilityFallback,
  type DegradationReport,
  type DependencyId,
  type DependencyProbe,
  type DependencySpec,
  type DependencyState,
  type DependencyStatus,
  type FallbackMode,
} from './dependency-degradation';

export interface ManualOverride {
  dependency: DependencyId;
  state: DependencyState;
  reason: string;
  setBy?: string;
  setAt: string;
}

export interface DegradedModeStatus {
  generatedAt: string;
  overall: DependencyState;
  dependencies: DependencyStatus[];
  overrides: Record<DependencyId, ManualOverride>;
  capabilities: Record<Capability, CapabilityDecision>;
}

export interface DegradedResponseEnvelope {
  success: false;
  code: string;
  error: string;
  degraded: true;
  retryAfter: number;
  correlationId?: string;
}

const ALL_CAPABILITIES: readonly Capability[] = [
  'invoice.create',
  'invoice.read',
  'payment.verify',
  'export.create',
  'notification.send',
  'job.enqueue',
] as const;

export class DegradedModeService {
  private probes: Partial<Record<DependencyId, DependencyProbe>>;
  private overrides = new Map<DependencyId, ManualOverride>();
  private cachedReport: DegradationReport | null = null;
  private cacheTtlMs: number;
  private lastReportTime = 0;

  constructor(options: {
    probes?: Partial<Record<DependencyId, DependencyProbe>>;
    cacheTtlMs?: number;
  } = {}) {
    this.probes = options.probes ? { ...options.probes } : {};
    this.cacheTtlMs = options.cacheTtlMs ?? 5_000;
  }

  public registerProbe(dependency: DependencyId, probe: DependencyProbe): void {
    this.probes[dependency] = probe;
    this.cachedReport = null;
  }

  public setOverride(
    dependency: DependencyId,
    state: DependencyState,
    reason: string,
    setBy?: string
  ): ManualOverride {
    // Validate dependency
    specFor(dependency);

    const override: ManualOverride = {
      dependency,
      state,
      reason,
      setBy: setBy ?? 'operator',
      setAt: new Date().toISOString(),
    };
    this.overrides.set(dependency, override);
    this.cachedReport = null;
    return override;
  }

  public clearOverride(dependency: DependencyId): boolean {
    const deleted = this.overrides.delete(dependency);
    if (deleted) this.cachedReport = null;
    return deleted;
  }

  public clearAllOverrides(): void {
    this.overrides.clear();
    this.cachedReport = null;
  }

  public getOverrides(): Record<DependencyId, ManualOverride> {
    return Object.fromEntries(this.overrides.entries()) as Record<DependencyId, ManualOverride>;
  }

  /**
   * Records a live failure detected during a request (e.g. Horizon timeout).
   * Automatically marks the dependency as down if the failure matches a known signature.
   */
  public recordFailure(dependency: DependencyId, errorMessage: string): string {
    const code = classifyFailure(dependency, errorMessage);
    this.cachedReport = null;
    return code;
  }

  /**
   * Evaluates current health across probes and applies manual overrides.
   */
  public async getStatus(options: { forceRefresh?: boolean; now?: () => Date } = {}): Promise<DegradedModeStatus> {
    const nowFn = options.now ?? (() => new Date());
    const nowTime = nowFn().getTime();

    if (
      !options.forceRefresh &&
      this.cachedReport &&
      nowTime - this.lastReportTime < this.cacheTtlMs &&
      this.overrides.size === 0
    ) {
      return this.buildStatusFromReport(this.cachedReport, nowFn);
    }

    const baseReport = await runDependencyChecks(this.probes, { now: nowFn });
    const mergedReport = this.applyOverridesToReport(baseReport, nowFn);

    this.cachedReport = mergedReport;
    this.lastReportTime = nowTime;

    return this.buildStatusFromReport(mergedReport, nowFn);
  }

  /**
   * Fast check for a single capability.
   */
  public async checkCapability(
    capability: Capability,
    options: { now?: () => Date } = {}
  ): Promise<CapabilityDecision> {
    const status = await this.getStatus(options);
    return status.capabilities[capability];
  }

  /**
   * Express middleware guarding an endpoint by capability.
   * If degraded, writes standard headers and returns user-safe fallback response.
   */
  public requireCapability(capability: Capability) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const decision = await this.checkCapability(capability);
        if (!decision.allowed && decision.fallback) {
          this.sendDegradedResponse(res, decision, req.correlationId);
          return;
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  /**
   * Sends user-safe fallback response with standard headers (Retry-After, X-Degraded-Mode).
   */
  public sendDegradedResponse(
    res: Response,
    decision: CapabilityDecision,
    correlationId?: string
  ): void {
    if (!decision.fallback) {
      res.status(503).json({
        success: false,
        code: 'SERVICE_DEGRADED',
        error: 'Service is temporarily degraded. Please try again shortly.',
        correlationId,
      });
      return;
    }

    const fb = decision.fallback;
    res.set('Retry-After', String(fb.retryAfterSeconds));
    res.set('X-Degraded-Mode', 'true');
    res.set('X-Degraded-Dependency', fb.dependency);
    res.set('X-Degraded-Capability', decision.capability);

    const payload: DegradedResponseEnvelope = {
      success: false,
      code: fb.code,
      error: fb.userMessage,
      degraded: true,
      retryAfter: fb.retryAfterSeconds,
      ...(correlationId ? { correlationId } : {}),
    };

    res.status(fb.httpStatus).json(payload);
  }

  /**
   * Helper to inspect error from an upstream call (e.g. Horizon, DB, Email).
   * If it matches an upstream dependency failure mode, returns the user-safe fallback decision.
   */
  public classifyUpstreamError(
    dependency: DependencyId,
    capability: Capability,
    err: unknown
  ): CapabilityDecision['fallback'] | null {
    const message = err instanceof Error ? err.message : String(err);
    const failureCode = classifyFailure(dependency, message);

    if (failureCode === 'UNCLASSIFIED') {
      return null;
    }

    const spec = specFor(dependency);
    const fallback = spec.fallbacks.find((f) => f.capability === capability);
    if (!fallback) return null;

    return {
      ...fallback,
      dependency,
      retryAfterSeconds: spec.retryAfterSeconds,
    };
  }

  private applyOverridesToReport(report: DegradationReport, nowFn: () => Date): DegradationReport {
    if (this.overrides.size === 0) return report;

    const rank: Record<DependencyState, number> = { healthy: 0, unknown: 1, degraded: 2, down: 3 };

    const dependencies = report.dependencies.map((dep) => {
      const override = this.overrides.get(dep.id);
      if (!override) return dep;

      const spec = specFor(dep.id);
      return {
        ...dep,
        state: override.state,
        failureMode: override.state === 'healthy' ? null : 'MANUAL_OVERRIDE',
        error: override.state === 'healthy' ? null : `Manual override: ${override.reason}`,
        affectedCapabilities: override.state === 'down' ? spec.fallbacks.map((f) => f.capability) : [],
      };
    });

    const overall = dependencies.reduce<DependencyState>(
      (worst, d) => (rank[d.state] > rank[worst] ? d.state : worst),
      'healthy'
    );

    return {
      generatedAt: nowFn().toISOString(),
      overall,
      dependencies,
    };
  }

  private buildStatusFromReport(report: DegradationReport, nowFn: () => Date): DegradedModeStatus {
    const capabilities = {} as Record<Capability, CapabilityDecision>;
    for (const cap of ALL_CAPABILITIES) {
      capabilities[cap] = capabilityStatus(report, cap);
    }

    return {
      generatedAt: nowFn().toISOString(),
      overall: report.overall,
      dependencies: report.dependencies,
      overrides: this.getOverrides(),
      capabilities,
    };
  }
}

export const degradedModeService = new DegradedModeService();
