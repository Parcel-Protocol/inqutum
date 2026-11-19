'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertOctagon, AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react';
import {
  SEVERITY_LABEL,
  clip,
  describeOpsError,
  formatAge,
  nextStep,
  isOpsApiError,
  type FailureDetail,
  type FailureFilter,
  type FailureItem,
  type FailureView,
  type OpsFailuresClient,
  type Severity,
} from '@/lib/ops-failures';
import { newIdempotencyKey } from '@/lib/idempotency-key';

/**
 * Operator dashboard for unresolved partial failures (#383).
 *
 * Lists the failures the API reports, lets an operator filter them, read the
 * classified cause and error history, and retry the ones a retry can help.
 *
 * Boundaries worth knowing:
 *  - The admin token lives in this component's state only. It is never written to
 *    storage, a URL or a log, it is cleared on sign-out and on a 401, and the
 *    input is a password field.
 *  - Hiding Retry is a courtesy. The server refuses a retry for a failure that
 *    needs the user (422), is not dead-lettered or already running (409).
 *  - A retry carries an idempotency key that is reused only if the same click is
 *    replayed after a network failure, so a double click or a flaky network
 *    cannot requeue a job twice.
 */

interface Props {
  client: OpsFailuresClient;
}

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-900 border-red-300',
  error: 'bg-orange-100 text-orange-900 border-orange-300',
  warning: 'bg-amber-100 text-amber-900 border-amber-300',
};

/** Severity is conveyed by text and icon as well as colour. */
function SeverityBadge({ severity }: { severity: Severity }) {
  const Icon = severity === 'critical' ? AlertOctagon : severity === 'error' ? AlertTriangle : Info;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLE[severity]}`}>
      <Icon className="w-3 h-3" aria-hidden="true" />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; view: FailureView } | { state: 'error'; message: string };

const EMPTY_FILTER: FailureFilter = { severity: '', operationType: '' };

export default function PartialFailureDashboard({ client }: Props) {
  const [token, setToken] = useState('');
  const [draft, setDraft] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FailureFilter>(EMPTY_FILTER);
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; data?: FailureDetail; error?: string } | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  // One key per item per intended retry; kept only while the outcome is unknown.
  const retryKeys = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  // Ignores a response that arrives after a newer request or a sign-out.
  const generation = useRef(0);

  const signOut = useCallback((message: string | null = null) => {
    generation.current += 1;
    setToken('');
    setDraft('');
    setLoad({ state: 'idle' });
    setOpen(null);
    setDetail(null);
    retryKeys.current.clear();
    setAuthError(message);
  }, []);

  const fetchList = useCallback(
    async (activeToken: string, activeFilter: FailureFilter) => {
      const mine = ++generation.current;
      setLoad({ state: 'loading' });
      try {
        const view = await client.list(activeToken, activeFilter);
        if (mine !== generation.current) return;
        setLoad({ state: 'ready', view });
      } catch (error) {
        if (mine !== generation.current) return;
        if (isOpsApiError(error) && error.kind === 'unauthorized') {
          signOut(describeOpsError(error));
          return;
        }
        setLoad({ state: 'error', message: describeOpsError(error) });
      }
    },
    [client, signOut],
  );

  useEffect(() => {
    if (token) void fetchList(token, filter);
    // Re-query when the token or the filter changes; fetchList is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filter]);

  const submitToken = (event: React.FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) {
      setAuthError('Enter the admin token.');
      return;
    }
    setAuthError(null);
    setToken(value);
    setDraft('');
  };

  const toggleDetail = async (item: FailureItem) => {
    if (open === item.id) {
      setOpen(null);
      return;
    }
    setOpen(item.id);
    setDetail({ id: item.id });
    try {
      const data = await client.detail(token, item.id);
      setDetail((current) => (current?.id === item.id ? { id: item.id, data } : current));
    } catch (error) {
      if (isOpsApiError(error) && error.kind === 'unauthorized') return signOut(describeOpsError(error));
      setDetail((current) => (current?.id === item.id ? { id: item.id, error: describeOpsError(error) } : current));
    }
  };

  const retry = async (item: FailureItem) => {
    // Synchronous guard: a double click lands before state has re-rendered.
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setRetrying((current) => new Set(current).add(item.id));
    const key = retryKeys.current.get(item.id) ?? newIdempotencyKey();
    retryKeys.current.set(item.id, key);
    setStatus(`Retrying ${item.operationType}…`);
    try {
      const result = await client.retry(token, item.id, key);
      retryKeys.current.delete(item.id);
      setStatus(
        result.status === 'duplicate'
          ? `${item.operationType} was already requeued by an earlier click.`
          : `${item.operationType} was requeued. It will run again shortly.`,
      );
      await fetchList(token, filter);
    } catch (error) {
      if (isOpsApiError(error)) {
        if (error.kind === 'unauthorized') return signOut(describeOpsError(error));
        // Only an unknown outcome (network, 5xx) keeps the key, so a replay is deduplicated.
        if (!error.retriable) retryKeys.current.delete(item.id);
        setStatus(describeOpsError(error));
        if (error.kind === 'conflict' || error.kind === 'not_found' || error.kind === 'user_action') await fetchList(token, filter);
      } else {
        setStatus('Retry failed. Try again.');
      }
    } finally {
      inFlight.current.delete(item.id);
      setRetrying((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  if (!token) {
    return (
      <form onSubmit={submitToken} className="card max-w-md mx-auto" aria-labelledby="ops-signin-title" noValidate>
        <h2 id="ops-signin-title" className="text-xl font-semibold mb-2">Operator access</h2>
        <p className="text-sm text-gray-600 mb-4">
          Enter the admin token to view unresolved failures. It is kept in this tab&apos;s memory only and is not stored.
        </p>
        <label htmlFor="ops-token" className="label">Admin token</label>
        <input
          id="ops-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={authError ? true : undefined}
          aria-describedby={authError ? 'ops-token-error' : undefined}
        />
        {authError && (
          <p id="ops-token-error" role="alert" className="text-sm text-red-700 mt-2">{authError}</p>
        )}
        <button type="submit" className="btn btn-primary mt-4">Open dashboard</button>
      </form>
    );
  }

  const view = load.state === 'ready' ? load.view : null;
  const filtered = Boolean(filter.severity || filter.operationType || filter.invoiceId || filter.stale !== undefined || filter.retryable !== undefined || filter.userActionRequired !== undefined);

  return (
    <section aria-labelledby="ops-failures-title">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 id="ops-failures-title" className="text-2xl font-semibold">Unresolved partial failures</h2>
        <div className="flex gap-2">
          <button type="button" className="btn btn-outline inline-flex items-center gap-2" onClick={() => void fetchList(token, filter)} aria-disabled={load.state === 'loading'}>
            <RefreshCw className="w-4 h-4" aria-hidden="true" /> Refresh
          </button>
          <button type="button" className="btn btn-outline" onClick={() => signOut()}>Sign out</button>
        </div>
      </div>

      {view && (
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4" aria-label="Summary">
          <div className="card"><dt className="text-sm text-gray-600">Unresolved</dt><dd className="text-2xl font-semibold">{view.summary.unresolved}</dd></div>
          <div className="card"><dt className="text-sm text-gray-600">Critical</dt><dd className="text-2xl font-semibold">{view.summary.bySeverity.critical}</dd></div>
          <div className="card"><dt className="text-sm text-gray-600">Retryable</dt><dd className="text-2xl font-semibold">{view.summary.retryable}</dd></div>
          <div className="card"><dt className="text-sm text-gray-600">Needs the user</dt><dd className="text-2xl font-semibold">{view.summary.userActionRequired}</dd></div>
        </dl>
      )}

      <form className="card mb-4 grid gap-3 md:grid-cols-5" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <div>
          <label htmlFor="f-severity" className="label">Severity</label>
          <select id="f-severity" className="input" value={filter.severity ?? ''} onChange={(e) => setFilter({ ...filter, severity: e.target.value as Severity | '' })}>
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-operation" className="label">Operation</label>
          <input id="f-operation" className="input" value={filter.operationType ?? ''} onChange={(e) => setFilter({ ...filter, operationType: e.target.value })} placeholder="e.g. email" />
        </div>
        <div>
          <label htmlFor="f-age" className="label">Age</label>
          <select id="f-age" className="input" value={filter.stale === undefined ? '' : String(filter.stale)} onChange={(e) => setFilter({ ...filter, stale: e.target.value === '' ? undefined : e.target.value === 'true' })}>
            <option value="">Any</option>
            <option value="true">Stale only</option>
            <option value="false">Not stale</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-retryable" className="label">Retry</label>
          <select id="f-retryable" className="input" value={filter.retryable === undefined ? '' : String(filter.retryable)} onChange={(e) => setFilter({ ...filter, retryable: e.target.value === '' ? undefined : e.target.value === 'true' })}>
            <option value="">Any</option>
            <option value="true">Retryable</option>
            <option value="false">Not retryable</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-user" className="label">Needs the user</label>
          <select id="f-user" className="input" value={filter.userActionRequired === undefined ? '' : String(filter.userActionRequired)} onChange={(e) => setFilter({ ...filter, userActionRequired: e.target.value === '' ? undefined : e.target.value === 'true' })}>
            <option value="">Any</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      </form>

      <p role="status" aria-live="polite" className="text-sm text-gray-700 min-h-[1.25rem] mb-2">{status}</p>

      {load.state === 'loading' && (
        <p className="flex items-center gap-2 text-gray-600" role="status">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading failures…
        </p>
      )}

      {load.state === 'error' && (
        <div role="alert" className="card border border-red-200 bg-red-50 text-red-950">
          <p className="font-semibold">Could not load failures</p>
          <p className="text-sm mt-1">{load.message}</p>
          <button type="button" className="btn btn-outline mt-3" onClick={() => void fetchList(token, filter)}>Try again</button>
        </div>
      )}

      {view && view.items.length === 0 && (
        <div className="card text-center py-10">
          <p className="font-semibold">{filtered ? 'No failures match these filters' : 'No unresolved failures'}</p>
          <p className="text-sm text-gray-600 mt-1">
            {filtered ? 'Clear a filter to see more.' : 'Everything that failed has been resolved or is retrying on its own.'}
          </p>
          {filtered && <button type="button" className="btn btn-outline mt-3" onClick={() => setFilter(EMPTY_FILTER)}>Clear filters</button>}
        </div>
      )}

      {view && view.items.length > 0 && (
        <>
          <p className="text-sm text-gray-600 mb-2">
            Showing {view.items.length} of {view.total}, most urgent first.
          </p>
          <ul className="space-y-3" aria-label="Unresolved failures">
            {view.items.map((item) => {
              const step = nextStep(item);
              const busy = retrying.has(item.id);
              const expanded = open === item.id;
              return (
                <li key={item.id} className="card">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={item.severity} />
                        <span className="font-semibold">{item.operationType}</span>
                        {item.stale && <span className="text-xs rounded-full border border-gray-300 px-2 py-0.5">Stale</span>}
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        {item.invoiceId ? `Invoice ${item.invoiceId} · ` : ''}
                        {formatAge(item.ageMinutes)} old · {item.attempts} {item.attempts === 1 ? 'attempt' : 'attempts'} · cause {item.cause.code}
                      </p>
                      {item.lastError && <p className="text-sm mt-1 break-words">{clip(item.lastError)}</p>}
                      {step.kind === 'contact_user' && (
                        <p className="text-sm mt-2 rounded border border-amber-300 bg-amber-50 text-amber-950 p-2">
                          <strong>Needs the user:</strong> {step.label}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn btn-outline"
                        aria-expanded={expanded}
                        aria-controls={`detail-${item.id}`}
                        onClick={() => void toggleDetail(item)}
                      >
                        {expanded ? 'Hide details' : 'Details'}<span className="sr-only"> for {item.operationType} {item.id}</span>
                      </button>
                      {step.kind === 'retry' && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          aria-disabled={busy}
                          aria-busy={busy}
                          onClick={() => void retry(item)}
                        >
                          {busy ? 'Retrying…' : 'Retry'}<span className="sr-only"> {item.operationType} {item.id}</span>
                        </button>
                      )}
                    </div>
                  </div>
                  {expanded && (
                    <div id={`detail-${item.id}`} className="mt-3 border-t pt-3 text-sm">
                      {!detail || detail.id !== item.id || (!detail.data && !detail.error) ? (
                        <p role="status">Loading history…</p>
                      ) : detail.error ? (
                        <p role="alert" className="text-red-700">{detail.error}</p>
                      ) : (
                        <>
                          <p className="mb-2">State: <strong>{detail.data!.state.replace('_', ' ')}</strong></p>
                          {detail.data!.history.length === 0 ? (
                            <p className="text-gray-600">No error history recorded.</p>
                          ) : (
                            <ol className="space-y-1" aria-label="Error history">
                              {detail.data!.history.map((h) => (
                                <li key={`${h.attempt}-${h.at}`}>
                                  <span className="font-medium">Attempt {h.attempt}</span> · {h.cause} · {clip(h.message)}
                                  <span className="text-gray-500"> ({h.at})</span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
