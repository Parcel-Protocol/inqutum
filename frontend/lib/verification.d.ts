export type VerificationCode =
  | 'MISSING_TX_HASH'
  | 'INVALID_TX_HASH'
  | 'INVALID_PAYER_NAME'
  | 'INVALID_PAYER_EMAIL'
  | 'PAYER_INFO_TOO_LONG'
  | 'INVOICE_ALREADY_PAID'
  | 'INVOICE_EXPIRED'
  | 'INVOICE_NOT_PENDING'
  | 'TRANSACTION_NOT_FOUND'
  | 'NO_PAYMENT_OPERATION'
  | 'MEMO_MISMATCH'
  | 'DESTINATION_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'ASSET_MISMATCH'
  | 'NETWORK_MISMATCH'
  | 'TX_HASH_ALREADY_USED';

export interface VerificationFailure {
  ok: false;
  code: VerificationCode;
  error: string;
}

export interface VerificationSuccess<T> {
  ok: true;
  value: T;
}

export type VerificationResult<T> = VerificationSuccess<T> | VerificationFailure;

export interface PayerInfo {
  payerName?: string;
  payerEmail?: string;
}

export interface ExpectedPayment {
  memo: string;
  amount: string | number;
  destination: string;
  assetCode: string;
  assetIssuer?: string;
  network?: string;
}

export interface HorizonTransactionLike {
  memo?: string | null;
  memo_type?: string | null;
}

export interface HorizonOperationLike {
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface VerifiedPayment {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo: string;
}

export interface VerifyPaymentInput {
  txHash: string;
  expected: ExpectedPayment;
  transaction: HorizonTransactionLike;
  operations: HorizonOperationLike[];
  network?: string;
}

export const STROOP_PRECISION: number;
export const VERIFICATION_MESSAGES: Record<VerificationCode, string>;

export function failure(code: VerificationCode): VerificationFailure;

export function isValidTxHash(txHash: unknown): boolean;

export function normalizeTransactionHash(value: unknown): string;

export function checkTxHash(txHash: unknown): VerificationResult<string>;

export function checkPayerInfo(input: PayerInfo): VerificationResult<PayerInfo>;

export function resolveVerificationError(error: unknown, fallback?: string): string;

export function parseToStroops(value: unknown): bigint | null;

export function amountsMatch(
  expected: string | number,
  actual: unknown,
  toleranceStroops?: number
): boolean;

export function verifyHorizonPayment(
  input: VerifyPaymentInput
): VerificationResult<VerifiedPayment>;
