'use client';

import Image from 'next/image';
import { getAssetByCode } from '@/lib/assets';
import { normalizeAssetCode } from '@/lib/asset-code-display';

interface AssetLogoProps {
  code: string;
  size?: number;
  showName?: boolean;
  className?: string;
  /**
   * Hides the logo from assistive technology.
   *
   * Set this wherever the asset code is already announced by adjacent text — a
   * heading, a select value, an aria-label on the amount. Without it the code
   * is read twice in a row, which is how "10 XLM" became "10 Stellar Lumens
   * XLM XLM" on the pay page.
   */
  decorative?: boolean;
}

function validateAssetCode(code: unknown): string {
  if (typeof code === 'string' && code.length > 0) {
    return code.toUpperCase();
  }
  return 'XLM';
}

function validateSize(size: unknown): number {
  const num = typeof size === 'number' ? size : 24;
  return num > 0 && num <= 512 ? num : 24;
}

export default function AssetLogo({
  code,
  size = 24,
  showName = true,
  className = '',
  decorative = false,
}: AssetLogoProps) {
  const normalizedCode = validateAssetCode(code);
  const validatedSize = validateSize(size);
  const asset = getAssetByCode(normalizedCode);

  if (!asset) {
    return (
      <span className={className} {...(decorative ? { 'aria-hidden': true } : {})}>
        {normalizedCode}
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 ${className}`}
      data-asset-code={asset.code}
      {...(decorative ? { 'aria-hidden': true } : {})}
    >
      <div
        className="rounded-full overflow-hidden flex items-center justify-center bg-white shadow-sm border border-gray-100"
        style={{
          width: validatedSize,
          height: validatedSize,
          minWidth: validatedSize,
          minHeight: validatedSize,
          padding: '2px'
        }}
      >
        <Image
          src={asset.logo}
          alt={decorative ? '' : asset.name}
          width={Math.max(validatedSize - 4, 1)}
          height={Math.max(validatedSize - 4, 1)}
          className="object-contain rounded-full"
          unoptimized
          priority
        />
      </div>
      {showName && (
        <span className="font-semibold">{asset.code}</span>
      )}
    </div>
  );
}
