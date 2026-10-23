import QRCode from 'qrcode';

/**
 * Maximum payload length accepted for QR generation. Protects against
 * oversized inputs that would produce unscannable or excessively large codes.
 */
const MAX_PAYLOAD_LENGTH = 2953; // QR version 40, byte mode, level L upper bound

/**
 * Error thrown for invalid QR generation input. Stable error code shared with
 * the MVP and persistent response conventions.
 */
export class QRCodeError extends Error {
  readonly code: 'QR_INVALID_INPUT' | 'QR_GENERATION_FAILED';

  constructor(code: 'QR_INVALID_INPUT' | 'QR_GENERATION_FAILED', message: string) {
    super(message);
    this.name = 'QRCodeError';
    this.code = code;
  }
}

const assertNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new QRCodeError('QR_INVALID_INPUT', `${field} must be a non-empty string`);
  }
  return value;
};

const assertPayloadLength = (value: string, field: string): void => {
  if (value.length > MAX_PAYLOAD_LENGTH) {
    throw new QRCodeError(
      'QR_INVALID_INPUT',
      `${field} exceeds maximum length of ${MAX_PAYLOAD_LENGTH} characters`
    );
  }
};

/**
 * Generate QR code for payment URL
 */
export const generatePaymentQR = async (paymentUrl: string): Promise<string> => {
  const url = assertNonEmptyString(paymentUrl, 'paymentUrl');
  assertPayloadLength(url, 'paymentUrl');

  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrDataUrl;
  } catch (error) {
    console.error('QR code generation error:', error);
    throw new QRCodeError('QR_GENERATION_FAILED', 'Failed to generate QR code');
  }
};

/**
 * Generate Stellar payment QR (SEP-0007 format)
 */
export const generateStellarPaymentQR = async (
  destination: string,
  amount: string,
  assetCode: string = 'XLM',
  memo?: string,
  assetIssuer?: string
): Promise<string> => {
  assertNonEmptyString(destination, 'destination');
  assertNonEmptyString(amount, 'amount');
  assertNonEmptyString(assetCode, 'assetCode');
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) {
    throw new QRCodeError('QR_INVALID_INPUT', 'amount must be a positive decimal with up to 7 places');
  }

  let stellarUri = `web+stellar:pay?destination=${encodeURIComponent(destination)}&amount=${amount}`;

  // Add asset information
  if (assetCode !== 'XLM') {
    if (!assetIssuer) {
      throw new QRCodeError('QR_INVALID_INPUT', 'assetIssuer is required for non-XLM assets');
    }
    stellarUri += `&asset_code=${encodeURIComponent(assetCode)}&asset_issuer=${encodeURIComponent(assetIssuer)}`;
  }

  if (memo) {
    stellarUri += `&memo=${encodeURIComponent(memo)}&memo_type=MEMO_TEXT`;
  }

  assertPayloadLength(stellarUri, 'stellarUri');

  try {
    return await QRCode.toDataURL(stellarUri, {
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 1,
    });
  } catch (error) {
    console.error('Stellar QR code generation error:', error);
    throw new QRCodeError('QR_GENERATION_FAILED', 'Failed to generate Stellar payment QR code');
  }
};

export default {
  generatePaymentQR,
  generateStellarPaymentQR,
};
