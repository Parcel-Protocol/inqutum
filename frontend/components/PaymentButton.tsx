'use client';

import { useState } from 'react';
import { sendPayment, checkWalletConnection, requestWalletAccess } from '@/lib/stellar';
import { toast } from 'sonner';
import { Wallet, Loader2 } from 'lucide-react';
import { invoiceApi } from '@/lib/api';
import { showFreighterInstallPrompt } from '@/components/FreighterInstallPrompt';
import { describeVerifyError } from '@/lib/payment-page-state';
import {
  validatePaymentRequest,
  classifyPaymentError,
} from '@/lib/payment-button-contract';

interface PaymentButtonProps {
  destination: string;
  amount: string;
  memo: string;
  assetCode?: string;
  assetIssuer?: string;
  invoiceId?: string;
  payerName?: string;
  payerEmail?: string;
  invoiceStatus?: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  /** Fired when the payer commits to paying, before the wallet is opened. */
  onStart?: () => void;
  onSuccess?: (txHash: string) => void;
  /** Fired when the attempt ends without a confirmed payment. */
  onError?: (message: string) => void;
}

const PAY_TOAST_ID = 'payment-flow';

export default function PaymentButton({
  destination,
  amount,
  memo,
  assetCode = 'XLM',
  assetIssuer,
  invoiceId,
  payerName,
  payerEmail,
  invoiceStatus = 'PENDING',
  onStart,
  onSuccess,
  onError,
}: PaymentButtonProps) {
  const [loading, setLoading] = useState(false);

  const handlePayment = async () => {
    if (loading) return;

    const validation = validatePaymentRequest({
      destination,
      amount,
      memo,
      assetCode,
      invoiceStatus,
      payerName,
      payerEmail,
    });
    if (!validation.ok) {
      toast.error(validation.error);
      onError?.(validation.error);
      return;
    }

    setLoading(true);
    onStart?.();

    try {
      let freighterInstalled = false;
      try {
        freighterInstalled = await checkWalletConnection();
      } catch {
        freighterInstalled = false;
      }
      if (!freighterInstalled) {
        showFreighterInstallPrompt();
        toast.info('Non-Freighter wallet? Use the QR code or manual payment details below.', {
          duration: 8000,
        });
        onError?.('Freighter is not installed');
        return;
      }

      let allowed = false;
      try {
        allowed = await requestWalletAccess();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        toast.error('Freighter access was denied');
        onError?.('Freighter access was denied');
        return;
      }

      toast.loading('Confirm in wallet...', { id: PAY_TOAST_ID });
      const txHash = await sendPayment(destination, amount, memo, assetCode, assetIssuer);

      if (invoiceId) {
        toast.loading('Verifying payment...', { id: PAY_TOAST_ID });
        try {
          await invoiceApi.verify(invoiceId, txHash, validation.payer);
          toast.success('Payment verified', {
            id: PAY_TOAST_ID,
            description: `TX: ${txHash.slice(0, 8)}...${txHash.slice(-8)}`,
          });
        } catch (error) {
          // The payment is on the ledger even though verification did not
          // complete, so this is a warning and the flow still reports success.
          console.error('Verification failed:', error);
          // Surface the shared rejection message rather than a generic warning.
          toast.warning('Payment sent but verification failed', {
            id: PAY_TOAST_ID,
            description: describeVerifyError(error, 'Refresh the page or wait for status to update'),
          });
        }
      } else {
        toast.success('Payment successful', {
          id: PAY_TOAST_ID,
          description: `TX: ${txHash.slice(0, 8)}...${txHash.slice(-8)}`,
        });
      }

      onSuccess?.(txHash);
    } catch (error: any) {
      const { title, description, duration } = classifyPaymentError(error, assetCode);
      toast.error(title, {
        id: PAY_TOAST_ID,
        description,
        duration,
      });
      onError?.(title);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handlePayment}
      disabled={loading || !destination || !amount || invoiceStatus !== 'PENDING'}
      aria-busy={loading}
      data-payment-state={loading ? 'processing' : 'ready'}
      className="btn btn-primary w-full flex items-center justify-center gap-2 text-lg py-4"
    >
      {loading ? (
        <>
          <Loader2 className="w-6 h-6 animate-spin" />
          Processing...
        </>
      ) : (
        <>
          <Wallet className="w-6 h-6" />
          Pay with Freighter
        </>
      )}
    </button>
  );
}
