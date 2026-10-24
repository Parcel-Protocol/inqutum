export declare function isDisplayableWallet(wallet: any): boolean;
export declare function truncateWalletAddress(wallet: any, prefixLen?: number, suffixLen?: number): string;
export declare function safeDisconnect(
  disconnectStore: () => void,
  onDisconnect?: (() => void) | null
): { ok: boolean; error?: string };
