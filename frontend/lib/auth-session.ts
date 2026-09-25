import { buildWalletChallenge } from './wallet-challenge.ts';

/**
 * Wallet sign-in for the API client.
 *
 * The server identifies a seller by a session token it issues after the seller
 * signs a challenge with their wallet (docs/ACCESS-CONTROL.md). This module
 * obtains and caches that token and attaches it to requests. It is a
 * convenience for talking to the API, not a security boundary: every action is
 * authorised server-side whatever the client does.
 *
 * Nothing here talks to Freighter, the wallet store or axios directly; those
 * are injected, so the behaviour (single-flight sign-in, expiry, one retry on
 * 401) is testable without a browser.
 */

export interface WalletSession {
  token: string;
  wallet: string;
  /** ISO-8601 instant after which the server refuses the token. */
  expiresAt: string;
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionManagerDeps {
  /** The connected wallet's public key, or null when none is connected. */
  getWallet(): string | null;
  /** Has the wallet sign a challenge transaction; resolves to the signed XDR. */
  signChallenge(xdr: string): Promise<string>;
  networkPassphrase: string;
  /** Exchanges the signed challenge; must not itself go through the auth interceptor. */
  exchange(signedXdr: string): Promise<WalletSession>;
  now?(): number;
  storage?: SessionStorageLike | null;
}

export class AuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';
  constructor(message = 'Connect your wallet to continue.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

const STORAGE_KEY = 'inqutum-wallet-session';
/** Refresh a little early so a token does not expire between attaching and arriving. */
const EXPIRY_MARGIN_MS = 30_000;

export interface SessionManager {
  /** The cached session for the connected wallet, or null. Never prompts. */
  current(): WalletSession | null;
  /** The current session, signing in first when there is none. Concurrent calls share one prompt. */
  ensure(): Promise<WalletSession>;
  clear(): void;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const now = deps.now ?? Date.now;
  let cached: WalletSession | null = null;
  let inFlight: Promise<WalletSession> | null = null;

  const readStored = (): WalletSession | null => {
    try {
      const raw = deps.storage?.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as WalletSession) : null;
    } catch {
      return null;
    }
  };

  const usable = (session: WalletSession | null): session is WalletSession =>
    Boolean(
      session &&
        session.wallet === deps.getWallet() &&
        Date.parse(session.expiresAt) - now() > EXPIRY_MARGIN_MS
    );

  const clear = () => {
    cached = null;
    try {
      deps.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: the in-memory copy is already gone */
    }
  };

  const current = () => {
    cached ??= readStored();
    if (usable(cached)) return cached;
    if (cached) clear();
    return null;
  };

  const ensure = async () => {
    const existing = current();
    if (existing) return existing;

    const wallet = deps.getWallet();
    if (!wallet) throw new AuthRequiredError();

    inFlight ??= (async () => {
      const challenge = buildWalletChallenge(wallet, { networkPassphrase: deps.networkPassphrase });
      const session = await deps.exchange(await deps.signChallenge(challenge));
      cached = session;
      try {
        deps.storage?.setItem(STORAGE_KEY, JSON.stringify(session));
      } catch {
        /* keep the in-memory session only */
      }
      return session;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return { current, ensure, clear };
}

/** The slice of an axios instance the auth wiring needs. */
export interface InterceptableClient {
  interceptors: {
    request: { use(onFulfilled: (config: any) => any): unknown };
    response: { use(onFulfilled: (response: any) => any, onRejected: (error: any) => any): unknown };
  };
  request(config: any): Promise<any>;
}

/**
 * Attaches the session token to outgoing requests, and when the server answers
 * 401 UNAUTHENTICATED signs in once and replays the request. A second 401 is
 * returned to the caller rather than looped on.
 *
 * Must be installed before any interceptor that rewrites errors, so it sees the
 * raw response.
 */
export function installWalletAuth(client: InterceptableClient, sessions: SessionManager): void {
  client.interceptors.request.use((config: any) => {
    const session = sessions.current();
    if (session && !config.headers?.Authorization) {
      config.headers = { ...config.headers, Authorization: `Bearer ${session.token}` };
    }
    return config;
  });

  client.interceptors.response.use(
    (response: any) => response,
    async (error: any) => {
      const config = error?.config;
      const unauthenticated =
        error?.response?.status === 401 && error.response?.data?.code === 'UNAUTHENTICATED';
      if (!unauthenticated || !config || config.__authRetried) throw error;

      sessions.clear();
      try {
        const session = await sessions.ensure();
        config.__authRetried = true;
        config.headers = { ...config.headers, Authorization: `Bearer ${session.token}` };
      } catch {
        // Not connected, or the user declined to sign: surface the original 401.
        throw error;
      }
      return client.request(config);
    }
  );
}
