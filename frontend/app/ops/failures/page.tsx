'use client';

import { useMemo } from 'react';
import PartialFailureDashboard from '@/components/PartialFailureDashboard';
import { createOpsFailuresClient } from '@/lib/ops-failures';
import { resolveApiConfig } from '@/lib/api-runtime';
import { MAIN_CONTENT_ID } from '@/lib/a11y';

/** Operator-only. Access is enforced by the API's admin token, not by this route being unlisted. */
export default function OpsFailuresPage() {
  const config = useMemo(() => resolveApiConfig(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV), []);
  const client = useMemo(
    () => createOpsFailuresClient({ baseUrl: config.baseUrl, fetch: (url, init) => fetch(url, init) }),
    [config.baseUrl],
  );

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="pt-20 pb-12 px-4 max-w-5xl mx-auto">
      {config.error ? (
        // Never send an admin token to the placeholder host a missing config resolves to.
        <div role="alert" className="card border border-red-200 bg-red-50 text-red-950">
          <p className="font-semibold">The operator dashboard cannot reach the API</p>
          <p className="text-sm mt-1">{config.error}</p>
        </div>
      ) : (
        <PartialFailureDashboard client={client} />
      )}
    </main>
  );
}
