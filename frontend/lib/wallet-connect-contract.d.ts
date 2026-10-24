export interface BalanceEntry {
  assetCode: string;
  balance: string;
}

export type BalanceErrorCode = 'UNFUNDED' | 'DEGRADED';

export declare const BALANCE_ERROR_CODES: Readonly<{
  UNFUNDED: 'UNFUNDED';
  DEGRADED: 'DEGRADED';
}>;

export declare function resolveXlmBalance(balances: BalanceEntry[]): string;
export declare function classifyBalanceError(error: any): BalanceErrorCode;
export declare function safeBalanceFallback(errorCode: BalanceErrorCode): string;
export declare function balanceErrorToast(
  errorCode: BalanceErrorCode,
  describeNetworkError?: (error: any) => string,
  error?: any
): { type: 'warning'; message: string; description?: string };

export interface LoadBalanceDeps {
  getAccountBalance: (key: string) => Promise<BalanceEntry[]>;
  setWallet: (key: string, balance: string) => any;
  describeNetworkError?: (error: any) => string;
  toast?: { warning?: (msg: string, opts?: any) => void };
}

export declare function executeLoadBalance(
  deps: LoadBalanceDeps,
  key: string
): Promise<{ ok: boolean; balance: string; errorCode?: BalanceErrorCode }>;
