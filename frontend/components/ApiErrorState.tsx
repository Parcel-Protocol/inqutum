'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { resolveRejectionExplanation, type ClientRejectionExplanation } from '@/lib/rejection-explanation';

interface ApiErrorStateProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
  error?: unknown;
  explanation?: Partial<ClientRejectionExplanation>;
}

export default function ApiErrorState({
  message,
  onRetry,
  compact = false,
  error,
  explanation,
}: ApiErrorStateProps) {
  const [retrying, setRetrying] = useState(false);
  const resolved = explanation || (error ? resolveRejectionExplanation(error) : null);

  const handleRetry = () => {
    if (!onRetry || retrying) return;

    setRetrying(true);
    try {
      Promise.resolve(onRetry())
        .catch(() => undefined)
        .finally(() => setRetrying(false));
    } catch {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`border border-red-200 bg-red-50 text-red-950 rounded-2xl ${compact ? 'p-4' : 'card py-10 text-center'}`}
    >
      <AlertTriangle className={`${compact ? 'w-5 h-5 inline mr-2' : 'w-12 h-12 mx-auto mb-4'} text-red-600`} />
      <p className="font-semibold">{resolved?.title || 'The Quittance API is unavailable'}</p>
      <p className="text-sm text-red-800 mt-1">{resolved?.summary || message}</p>
      {resolved?.reasonCode && (
        <p className="text-xs font-mono text-red-700 mt-2" data-testid="rejection-reason-code">
          Code: {resolved.reasonCode}
        </p>
      )}
      {resolved?.recoveryHints && resolved.recoveryHints.length > 0 && (
        <ul className="text-xs text-red-900 mt-2 space-y-1" data-testid="rejection-recovery-hints">
          {resolved.recoveryHints.map((hint) => (
            <li key={hint.step}>{hint.action}</li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" onClick={handleRetry} disabled={retrying} className="btn btn-outline mt-4 inline-flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying...' : 'Retry'}
        </button>
      )}
    </div>
  );
}
