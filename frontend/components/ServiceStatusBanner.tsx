'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { fetchServiceStatus } from '@/lib/api';
import { describeServiceStatus, formatRetryAfter, type ServiceStatusNotice } from '@/lib/service-status';

/** How often to re-check while the page is open. The server caches for ~10 s. */
export const SERVICE_STATUS_POLL_MS = 60_000;

/**
 * Tells the user which features are degraded and when to retry (#381).
 *
 * Renders nothing while everything works or when the status is unknown, so it
 * never cries wolf. It is a polite `status` region, not an alert: an outage in
 * a background dependency should not interrupt whatever the user is typing.
 * A dismissal lasts until the set of affected features changes.
 */
export default function ServiceStatusBanner() {
  const [notice, setNotice] = useState<ServiceStatusNotice | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const status = await fetchServiceStatus();
    // A failed check keeps the last notice: no news is not good news.
    if (status) setNotice(describeServiceStatus(status));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled && document.visibilityState !== 'hidden') void refresh();
    };
    run();
    const timer = window.setInterval(run, SERVICE_STATUS_POLL_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [refresh]);

  if (!notice) return null;
  const key = notice.issues.map((i) => `${i.capability}:${i.state}`).join('|');
  if (dismissedKey === key) return null;

  const unavailable = notice.severity === 'unavailable';
  const retry = formatRetryAfter(notice.retryAfterSeconds);

  return (
    <aside
      role="status"
      aria-live="polite"
      data-severity={notice.severity}
      className={`fixed top-16 left-4 right-4 sm:left-auto sm:max-w-lg z-[90] rounded-2xl shadow-xl p-4 ${
        unavailable ? 'bg-red-50 text-red-950 border border-red-200' : 'bg-amber-50 text-amber-950 border border-amber-200'
      }`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="flex-1">
          <p className="font-semibold">{notice.title}</p>
          <ul className="mt-2 space-y-2 text-sm">
            {notice.issues.map((issue) => (
              <li key={issue.capability}>
                <span className="font-medium">{issue.label}:</span> {issue.message}
              </li>
            ))}
          </ul>
          {retry && <p className="mt-2 text-sm">Please try again in {retry}.</p>}
        </div>
        <button type="button" onClick={() => setDismissedKey(key)} aria-label="Dismiss service status notice">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
