/**
 * User-facing status for degraded dependencies (#381).
 *
 * `dependency-degradation.ts` answers the operator's question ("which
 * dependency is broken, and why?"). This module answers the user's ("can I do
 * what I came here to do, and when should I try again?"). It turns a
 * `DegradationReport` into per-feature states using only the user-safe copy the
 * matrix already carries, so a status page can be public without leaking
 * hosts, error text, latencies, runbook links or the names of our vendors.
 *
 * Rules:
 *  - A feature is `unavailable` only when its fallback is `refuse` (we will not
 *    guess an answer), `degraded` when the work is accepted but delayed or the
 *    dependency is merely slow, and `operational` otherwise.
 *  - `unknown` means "no probe has told us anything"; it never blocks and never
 *    raises the overall state. The UI shows nothing for it.
 *  - Output is derived, never echoed: only the allow-listed fields below leave
 *    this module.
 */

import {
  DEPENDENCY_MATRIX,
  capabilityStatus,
  type Capability,
  type DegradationReport,
  type DependencyState,
} from './dependency-degradation';

export type UserFacingState = 'operational' | 'degraded' | 'unavailable' | 'unknown';

export interface UserFacingFeature {
  capability: Capability;
  /** Plain-language name of what the user is trying to do. */
  label: string;
  state: UserFacingState;
  /** Stable machine code for clients; `null` while operational or unknown. */
  code: string | null;
  /** Secret-free message to show the user; `null` while operational or unknown. */
  message: string | null;
  /** Seconds to wait before retrying; `null` when no retry is needed. */
  retryAfterSeconds: number | null;
}

export interface UserStatus {
  generatedAt: string;
  overall: UserFacingState;
  /** One sentence summarising `overall`; safe to render as-is. */
  summary: string;
  features: UserFacingFeature[];
}

export const FEATURE_LABELS: Readonly<Record<Capability, string>> = {
  'invoice.create': 'Creating invoices',
  'invoice.read': 'Viewing invoices',
  'payment.verify': 'Payment confirmation',
  'export.create': 'Data export',
  'notification.send': 'Email and notifications',
  'job.enqueue': 'Background processing',
};

const SLOW_MESSAGE = 'This is responding more slowly than usual. It still works; please allow extra time.';

const SUMMARIES: Readonly<Record<UserFacingState, string>> = {
  operational: 'All systems are operational.',
  degraded: 'Some features are slower or delayed. Your data and payments are safe.',
  unavailable: 'Some features are temporarily unavailable. Your data and payments are safe.',
  unknown: 'Status is not available right now.',
};

const SEVERITY: Record<UserFacingState, number> = { operational: 0, unknown: 0, degraded: 2, unavailable: 3 };

/** Features in a stable order: the order the matrix first mentions them. */
function orderedCapabilities(): Capability[] {
  const seen = new Set<Capability>();
  for (const dep of DEPENDENCY_MATRIX) for (const fb of dep.fallbacks) seen.add(fb.capability);
  return [...seen];
}

function dependencyStatesFor(report: DegradationReport, capability: Capability): DependencyState[] {
  return report.dependencies
    .filter((dep) => DEPENDENCY_MATRIX.find((spec) => spec.id === dep.id)?.fallbacks.some((fb) => fb.capability === capability))
    .map((dep) => dep.state);
}

export function buildUserStatus(report: DegradationReport): UserStatus {
  const features: UserFacingFeature[] = orderedCapabilities().map((capability) => {
    const label = FEATURE_LABELS[capability];
    const decision = capabilityStatus(report, capability);

    if (decision.fallback) {
      const { mode, code, userMessage, retryAfterSeconds } = decision.fallback;
      return {
        capability,
        label,
        state: mode === 'refuse' ? 'unavailable' : 'degraded',
        code,
        message: userMessage,
        retryAfterSeconds,
      };
    }

    const states = dependencyStatesFor(report, capability);
    if (states.includes('degraded')) {
      return { capability, label, state: 'degraded', code: 'SLOW_RESPONSE', message: SLOW_MESSAGE, retryAfterSeconds: null };
    }
    // Every dependency behind this feature is unprobed: say nothing rather than claim health.
    const state: UserFacingState = states.every((s) => s === 'unknown') ? 'unknown' : 'operational';
    return { capability, label, state, code: null, message: null, retryAfterSeconds: null };
  });

  const known = features.filter((f) => f.state !== 'unknown');
  const overall: UserFacingState =
    known.length === 0
      ? 'unknown'
      : known.reduce<UserFacingState>((worst, f) => (SEVERITY[f.state] > SEVERITY[worst] ? f.state : worst), 'operational');

  return { generatedAt: report.generatedAt, overall, summary: SUMMARIES[overall], features };
}

/** Status served when the checks themselves could not run. Never blocks anything. */
export function unknownUserStatus(now: Date): UserStatus {
  return buildUserStatus({ generatedAt: now.toISOString(), overall: 'unknown', dependencies: [] });
}
