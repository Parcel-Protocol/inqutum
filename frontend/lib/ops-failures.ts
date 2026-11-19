/**
 * Client and view model for the operator dashboard of unresolved partial
 * failures (#383).
 *
 * The server is the boundary: every route here needs the admin bearer token and
 * the server refuses a retry the UI would not offer (docs/PARTIAL-FAILURES.md).
 * This module only talks to those routes and shapes their answers for display.
 *
 * Nothing here touches the DOM, storage or a global `fetch`. The transport is
 * injected so the behaviour is testable without a browser, and the admin token is
 * passed per call rather than held, so it never ends up in module state.
 *
 * Kept to erasable TypeScript so Node can load it directly in tests.
 */

export type Severity = 'critical' | 'error' | 'warning';

export interface FailureCause {
  code: string;
  userActionRequired: boolean;
  userAction: string | null;
}

export interface FailureItem {
  id: string;
  operationType: string;
  invoiceId: string | null;
  severity: Severity;
  ageBucket: string;
  ageMinutes: number;
  stale: boolean;
  retryable: boolean;
  attempts: number;
  lastError: string | null;
  recoveryAction: 'retry' | 'inspect' | 'none';
  links: { inspect: string; retry: string | null; remediation: string };
  cause: FailureCause;
  userActionRequired: boolean;
}

export interface FailureSummary {
  unresolved: number;
  retryable: number;
  userActionRequired: number;
  bySeverity: Record<Severity, number>;
  byOperationType: Record<string, number>;
}

export interface FailureView {
  generatedAt: string;
  items: FailureItem[];
  total: number;
  summary: FailureSummary;
}

export interface FailureHistoryEntry {
  attempt: number;
  at: string;
  message: string;
  cause: string;
}

export interface FailureDetail {
  item: FailureItem | null;
  history: FailureHistoryEntry[];
  state: 'open' | 'resolved' | 'ignored' | 'not_failed';
}

export interface FailureFilter {
  severity?: Severity | '';
  operationType?: string;
  stale?: boolean;
  retryable?: boolean;
  userActionRequired?: boolean;
  invoiceId?: string;
  limit?: number;
}

export type OpsErrorKind =
  | 'unauthorized'
  | 'disabled'
  | 'not_found'
  | 'conflict'
  | 'user_action'
  | 'invalid'
  | 'unavailable';

export class OpsApiError extends Error {
  kind: OpsErrorKind;
  status: number;
  code: string;
  /** True when sending the same request again could succeed (network, 5xx, 429). */
  retriable: boolean;

  constructor(kind: OpsErrorKind, status: number, code: string, message: string) {
    super(message);
    this.name = 'OpsApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retriable = kind === 'unavailable';
  }
}

/**
 * Structural check rather than `instanceof`: the same class can be loaded twice
 * (separate bundles or chunks), and `instanceof` is false across copies.
 */
export function isOpsApiError(error: unknown): error is OpsApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'OpsApiError' &&
    typeof (error as { kind?: unknown }).kind === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  );
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OpsFailuresClientOptions {
  /** API base including `/api`, e.g. `https://host/api`. */
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

export interface RetryResult {
  status: 'requeued' | 'duplicate';
  jobId: string;
}

const MAX_MESSAGE = 300;
const MAX_ITEMS = 500;

export function errorKind(status: number): OpsErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'disabled';
  if (status === 404) return 'not_found';
  if (status === 400) return 'invalid';
  if (status === 422) return 'user_action';
  if (status === 409) return 'conflict';
  return 'unavailable';
}

/** Operator-facing wording for each error kind. Never echoes the token. */
export function describeOpsError(error: unknown): string {
  if (!isOpsApiError(error)) return 'Something went wrong. Try again.';
  switch (error.kind) {
    case 'unauthorized':
      return 'The admin token was rejected. Enter it again.';
    case 'disabled':
      return 'Operator access is not enabled on this deployment (the admin token is not configured).';
    case 'not_found':
      return 'That failure no longer exists. It may have been resolved. Refresh the list.';
    case 'invalid':
      return error.message || 'The filter was not accepted.';
    case 'user_action':
      return error.message || 'This failure needs action from the user, so a retry cannot help.';
    case 'conflict':
      return error.message || 'The job changed while you were looking. Refresh and check its state.';
    default:
      return 'The API could not be reached. Nothing was changed. Try again.';
  }
}

/** Query string for a filter. Empty and undefined fields are left out. */
export function buildQuery(filter: FailureFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.operationType?.trim()) params.set('operationType', filter.operationType.trim());
  if (filter.invoiceId?.trim()) params.set('invoiceId', filter.invoiceId.trim());
  for (const key of ['stale', 'retryable', 'userActionRequired'] as const) {
    if (typeof filter[key] === 'boolean') params.set(key, String(filter[key]));
  }
  if (typeof filter.limit === 'number' && Number.isFinite(filter.limit)) {
    params.set('limit', String(Math.min(Math.max(Math.trunc(filter.limit), 1), MAX_ITEMS)));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SEVERITIES: Severity[] = ['critical', 'error', 'warning'];
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** Clip long server text so one bad row cannot blow up the layout. */
export function clip(value: string | null | undefined, max = MAX_MESSAGE): string {
  const s = (value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Defensive parse: a malformed row is dropped, not rendered half-broken. */
export function parseItem(raw: unknown): FailureItem | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const severity = SEVERITIES.includes(raw.severity as Severity) ? (raw.severity as Severity) : 'error';
  const cause = isRecord(raw.cause) ? raw.cause : {};
  const links = isRecord(raw.links) ? raw.links : {};
  const userActionRequired = raw.userActionRequired === true || cause.userActionRequired === true;
  const retryLink = typeof links.retry === 'string' ? links.retry : null;
  return {
    id: raw.id,
    operationType: text(raw.operationType, 'unknown'),
    invoiceId: typeof raw.invoiceId === 'string' ? raw.invoiceId : null,
    severity,
    ageBucket: text(raw.ageBucket),
    ageMinutes: num(raw.ageMinutes),
    stale: raw.stale === true,
    retryable: raw.retryable === true,
    attempts: num(raw.attempts),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    recoveryAction: raw.recoveryAction === 'retry' || raw.recoveryAction === 'none' ? raw.recoveryAction : 'inspect',
    links: { inspect: text(links.inspect), retry: userActionRequired ? null : retryLink, remediation: text(links.remediation) },
    cause: {
      code: text(cause.code, 'UNKNOWN'),
      userActionRequired,
      userAction: typeof cause.userAction === 'string' ? cause.userAction : null,
    },
    userActionRequired,
  };
}

export function parseView(raw: unknown): FailureView {
  if (!isRecord(raw)) throw new OpsApiError('unavailable', 502, 'BAD_RESPONSE', 'Unexpected response from the API');
  const items = (Array.isArray(raw.items) ? raw.items : []).map(parseItem).filter((i): i is FailureItem => i !== null);
  const s = isRecord(raw.summary) ? raw.summary : {};
  const sev = isRecord(s.bySeverity) ? s.bySeverity : {};
  return {
    generatedAt: text(raw.generatedAt),
    items,
    total: num(raw.total, items.length),
    summary: {
      unresolved: num(s.unresolved, items.length),
      retryable: num(s.retryable),
      userActionRequired: num(s.userActionRequired),
      bySeverity: { critical: num(sev.critical), error: num(sev.error), warning: num(sev.warning) },
      byOperationType: isRecord(s.byOperationType)
        ? Object.fromEntries(Object.entries(s.byOperationType).map(([k, v]) => [k, num(v)]))
        : {},
    },
  };
}

export function parseDetail(raw: unknown): FailureDetail {
  if (!isRecord(raw)) throw new OpsApiError('unavailable', 502, 'BAD_RESPONSE', 'Unexpected response from the API');
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter(isRecord)
    .map((h) => ({ attempt: num(h.attempt), at: text(h.at), message: clip(text(h.message)), cause: text(h.cause, 'UNKNOWN') }));
  const state = ['open', 'resolved', 'ignored', 'not_failed'].includes(text(raw.state)) ? (raw.state as FailureDetail['state']) : 'open';
  return { item: raw.item ? parseItem(raw.item) : null, history, state };
}

/** "5 min", "3 h", "2 d": a rough age is enough to triage by. */
export function formatAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', error: 'Error', warning: 'Warning' };

/** What an operator can do next, in words. Drives the action column and its tests. */
export function nextStep(item: FailureItem): { kind: 'retry' | 'contact_user' | 'inspect'; label: string } {
  if (item.userActionRequired) return { kind: 'contact_user', label: item.cause.userAction ?? 'The user must act; a retry will not help.' };
  if (item.links.retry !== null) return { kind: 'retry', label: 'Retry the job' };
  return { kind: 'inspect', label: 'Inspect; it will retry on its own or needs a manual fix' };
}

export function createOpsFailuresClient(options: OpsFailuresClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 12_000;

  async function call(token: string, method: string, path: string, extra: Record<string, string> = {}): Promise<unknown> {
    if (!token) throw new OpsApiError('unauthorized', 401, 'NO_TOKEN', 'An admin token is required');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra },
        signal: controller?.signal,
      });
    } catch {
      throw new OpsApiError('unavailable', 0, 'NETWORK', 'Could not reach the API');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const b = isRecord(body) ? body : {};
      throw new OpsApiError(errorKind(response.status), response.status, text(b.code, 'ERROR'), clip(text(b.error)));
    }
    if (!isRecord(body) || body.success !== true) throw new OpsApiError('unavailable', response.status, 'BAD_RESPONSE', 'Unexpected response from the API');
    return body.data;
  }

  return {
    async list(token: string, filter: FailureFilter = {}): Promise<FailureView> {
      return parseView(await call(token, 'GET', `/ops/partial-failures${buildQuery(filter)}`));
    },
    async detail(token: string, id: string): Promise<FailureDetail> {
      return parseDetail(await call(token, 'GET', `/ops/partial-failures/${encodeURIComponent(id)}`));
    },
    /** The key makes a replay of the same attempt safe; reuse it only for the same click. */
    async retry(token: string, id: string, idempotencyKey: string): Promise<RetryResult> {
      const data = await call(token, 'POST', `/ops/partial-failures/${encodeURIComponent(id)}/retry`, { 'Idempotency-Key': idempotencyKey });
      const d = isRecord(data) ? data : {};
      const job = isRecord(d.job) ? d.job : {};
      return { status: d.status === 'duplicate' ? 'duplicate' : 'requeued', jobId: text(job.id, id) };
    },
  };
}

export type OpsFailuresClient = ReturnType<typeof createOpsFailuresClient>;
