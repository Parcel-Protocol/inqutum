'use client';

import { QRCodeSVG } from 'qrcode.react';
import { Copy, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '@/lib/utils';
import { toast } from 'sonner';

interface QRCodeDisplayProps {
  value: string;
  title?: string;
  size?: number;
  showCopy?: boolean;
}

const MIN_SIZE = 64;
const MAX_SIZE = 1024;
const COPY_FEEDBACK_MS = 2000;

/**
 * Normalises the requested render size. Non-finite or out-of-range values fall
 * back to the default so a bad prop can never produce a 0px or unbounded image.
 */
export function resolveQRSize(size: number | undefined): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 256;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));
}

/**
 * A value is treated as a backend-rendered image only when it is a PNG/JPEG/GIF
 * base64 data URL. Anything else starting with "data:" (e.g. data:text/html)
 * is rejected so it can never be rendered as an image source.
 */
export function isSafeImageDataUrl(value: string): boolean {
  return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

/** Payment request values must be non-empty, single-line, and free of whitespace. */
export function isValidPaymentValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/\s/.test(value.trim());
}

export default function QRCodeDisplay({
  value,
  title,
  size = 256,
  showCopy = true,
}: QRCodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const renderSize = resolveQRSize(size);
  const valid = isValidPaymentValue(value);
  const isBase64Image = valid && value.startsWith('data:image');
  const imageSafe = isBase64Image && isSafeImageDataUrl(value.trim());

  // Reset transient UI state whenever the payment value changes so a stale
  // "copied" or "image failed" state never misrepresents the new request.
  useEffect(() => {
    setImageFailed(false);
    setCopied(false);
    if (copyTimer.current) {
      clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!valid) return;
    let success = false;
    try {
      success = await copyToClipboard(value);
    } catch {
      success = false;
    }
    if (success) {
      setCopied(true);
      toast.success('Copied to clipboard!');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } else {
      toast.error('Failed to copy');
    }
  };

  if (!valid) {
    return (
      <div role="status" className="pay-qr-placeholder">
        Payment QR code is preparing...
      </div>
    );
  }

  if (isBase64Image && !imageSafe) {
    return (
      <div role="alert" className="pay-qr-error">
        Payment QR code could not be displayed. Please refresh the page.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {title && (
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      )}

      <div className="bg-white p-5 rounded-xl border-2 border-gray-200 shadow-lg">
        {isBase64Image ? (
          imageFailed ? (
            <div role="alert" className="pay-qr-error">
              Payment QR code could not be loaded. Please refresh the page.
            </div>
          ) : (
            // Display base64 image from backend
            <img
              src={value.trim()}
              alt="QR Code"
              width={renderSize}
              height={renderSize}
              className="block"
              onError={() => setImageFailed(true)}
            />
          )
        ) : (
          // Generate QR code from URL
          <QRCodeSVG
            value={value.trim()}
            size={renderSize}
            level="H"
            includeMargin={true}
          />
        )}
      </div>

      {showCopy && (
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 bg-gray-50 p-3 rounded-lg border border-gray-200">
            <code className="flex-1 text-xs text-gray-700 truncate font-mono">
              {value}
            </code>
            <button
              type="button"
              aria-label="Copy payment request"
              onClick={handleCopy}
              className="btn btn-secondary p-2 shrink-0 hover:scale-105 transition-transform"
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="w-4 h-4 text-green-600" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
