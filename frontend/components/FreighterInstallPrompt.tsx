'use client';

import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import {
  FREIGHTER_INSTALL_URL,
  FREIGHTER_REQUIRED_MESSAGE,
  FREIGHTER_WRONG_NETWORK_MESSAGE,
  type WalletGateResult,
} from '@/lib/freighter-availability';
import { freighterInstallMessage } from '@/lib/freighter-prompt-copy';

const FREIGHTER_TOAST_ID = 'freighter-not-installed';
const FREIGHTER_NETWORK_TOAST_ID = 'freighter-wrong-network';

const defaultGate: WalletGateResult = {
  status: 'missing',
  ready: false,
  title: 'Install Freighter',
  message: FREIGHTER_REQUIRED_MESSAGE,
  action: 'install',
};

export const showFreighterInstallPrompt = (gate: WalletGateResult = defaultGate) => {
  toast.error(gate.title, {
    id: FREIGHTER_TOAST_ID,
    description: gate.action === 'install' ? (
      <span>
        {gate.message}{' '}
        {/*
          The link is the only way out of this toast, and it opens a new tab.
          Saying so in the accessible name means a screen-reader user is not
          surprised by the context switch (issue #289).
        */}
        <a
          href={FREIGHTER_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold underline"
        >
          Install Freighter
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </span>
    ) : (
      gate.message
    ),
    // Ten seconds is short for a message carrying the only actionable link in
    // the flow, so the toast stays until it is dismissed.
    duration: Infinity,
  });
};

export const showFreighterWrongNetworkPrompt = (targetNetwork = 'Testnet') => {
  toast.error('Wrong Stellar network', {
    id: FREIGHTER_NETWORK_TOAST_ID,
    description: FREIGHTER_WRONG_NETWORK_MESSAGE(targetNetwork),
    duration: 8000,
  });
};

export interface FreighterInstallPromptProps {
  gate?: WalletGateResult;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}

export function FreighterInstallPrompt({
  gate = defaultGate,
  action,
  compact = false,
  className = '',
  children,
}: FreighterInstallPromptProps) {
  if (gate.ready) return null;

  return (
    <div className={`p-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 ${className}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 text-left text-sm">
          <p className="font-medium text-amber-800">{gate.title}</p>
          <p className="mt-1 text-amber-700">
            {gate.message}{' '}
            {gate.action === 'install' && (
              <a
                href={FREIGHTER_INSTALL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline inline-flex items-center gap-1 hover:text-amber-900"
              >
                Install Freighter
                <ExternalLink className="w-3.5 h-3.5 inline" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </p>
          {(action || children) && (
            <div className="mt-3 flex items-center gap-3">
              {action}
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FreighterInstallPrompt;
