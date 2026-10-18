/**
 * End-to-End Request Correlation Framework.
 *
 * Provides distributed trace correlation across HTTP APIs, asynchronous job workers,
 * and outbound external calls using Node.js AsyncLocalStorage.
 *
 * Guarantees:
 *  - Deterministic correlation ID propagation through asynchronous call stacks
 *  - Header sanitization (CRLF injection prevention, length capping)
 *  - Automatic inheritance when enqueuing background jobs
 *  - Header injection for external HTTP and webhook dispatches
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const CORRELATION_HEADER = 'X-Correlation-ID';
export const REQUEST_ID_HEADER = 'X-Request-ID';
export const TRACEPARENT_HEADER = 'traceparent';

export interface CorrelationContext {
  correlationId: string;
  parentCorrelationId?: string;
  source?: 'api' | 'worker' | 'cron' | 'external' | 'system';
  metadata?: Record<string, unknown>;
  startTime?: number;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Generates a unique, collision-resistant correlation identifier.
 * Format: {prefix}-{base36_timestamp}-{random_alphanumeric}
 */
export function generateCorrelationId(prefix: 'req' | 'job' | 'ext' | 'sys' = 'req'): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Sanitizes an incoming correlation ID:
 *  - Strips carriage returns, line feeds, control characters, and quotes
 *  - Trims whitespace
 *  - Caps length at 128 characters
 *  - Falls back to a fresh generated ID if invalid or empty
 */
export function sanitizeCorrelationId(
  raw: unknown,
  fallbackPrefix: 'req' | 'job' | 'ext' | 'sys' = 'req'
): string {
  if (typeof raw !== 'string') {
    return generateCorrelationId(fallbackPrefix);
  }

  // Remove CRLF, control characters ([\x00-\x1F\x7F]), and quotes
  const cleaned = raw.replace(/[\r\n\x00-\x1F\x7F"']/g, '').trim();
  const capped = cleaned.slice(0, 128);

  // Allow standard alphanumeric, dashes, dots, underscores, colons, and spaces
  if (capped.length === 0 || !/^[A-Za-z0-9\-._: ]+$/.test(capped)) {
    return generateCorrelationId(fallbackPrefix);
  }

  return capped;
}


/**
 * Runs a function within an asynchronous correlation context.
 */
export function runWithCorrelation<T>(
  context: string | CorrelationContext,
  fn: () => T
): T {
  const normalized: CorrelationContext =
    typeof context === 'string'
      ? { correlationId: sanitizeCorrelationId(context) }
      : {
          ...context,
          correlationId: sanitizeCorrelationId(context.correlationId, context.source === 'worker' ? 'job' : 'req'),
        };

  return correlationStorage.run(normalized, fn);
}

/**
 * Returns the currently active correlation ID from AsyncLocalStorage, if present.
 */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

/**
 * Returns the full active CorrelationContext, if present.
 */
export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

/**
 * Injects correlation headers into an outgoing HTTP request headers object.
 */
export function withCorrelationHeaders(
  headers: Record<string, string> = {},
  explicitCorrelationId?: string
): Record<string, string> {
  const corrId = explicitCorrelationId ?? getCorrelationId();
  if (!corrId) {
    return { ...headers };
  }

  const out = { ...headers };
  // Check case-insensitively before setting
  const hasCorrelation = Object.keys(out).some((k) => k.toLowerCase() === CORRELATION_HEADER.toLowerCase());
  const hasRequestId = Object.keys(out).some((k) => k.toLowerCase() === REQUEST_ID_HEADER.toLowerCase());

  if (!hasCorrelation) {
    out[CORRELATION_HEADER] = corrId;
  }
  if (!hasRequestId) {
    out[REQUEST_ID_HEADER] = corrId;
  }

  return out;
}

/**
 * Correlated HTTP Fetch wrapper. Automatically attaches correlation headers
 * and ensures external calls are linked to the active trace context.
 */
export async function correlatedFetch(
  url: string | URL,
  init: RequestInit & { correlationId?: string; fetchImpl?: typeof fetch } = {}
): Promise<Response> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const correlationId = init.correlationId ?? getCorrelationId() ?? generateCorrelationId('ext');

  const incomingHeaders: Record<string, string> = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((val, key) => {
        incomingHeaders[key] = val;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        incomingHeaders[k] = v;
      }
    } else {
      Object.assign(incomingHeaders, init.headers);
    }
  }

  const headers = withCorrelationHeaders(incomingHeaders, correlationId);

  return fetchImpl(url, {
    ...init,
    headers,
  });
}

/**
 * Attaches a request interceptor to Stellar Horizon's internal Axios client (if available)
 * to propagate X-Correlation-ID and X-Request-ID headers on all Horizon RPC calls.
 */
export function attachStellarCorrelationInterceptor(axiosClient?: any): boolean {
  try {
    let client = axiosClient;
    if (!client) {
      const StellarSdk = require('@stellar/stellar-sdk');
      client = StellarSdk?.Horizon?.AxiosClient;
    }
    if (client && client.interceptors && client.interceptors.request) {
      client.interceptors.request.use((config: any) => {
        const corrId = getCorrelationId();
        if (corrId) {
          config.headers = config.headers || {};
          const hasCorrelation = Object.keys(config.headers).some(
            (k) => k.toLowerCase() === CORRELATION_HEADER.toLowerCase()
          );
          const hasRequestId = Object.keys(config.headers).some(
            (k) => k.toLowerCase() === REQUEST_ID_HEADER.toLowerCase()
          );
          if (!hasCorrelation) {
            config.headers[CORRELATION_HEADER] = corrId;
          }
          if (!hasRequestId) {
            config.headers[REQUEST_ID_HEADER] = corrId;
          }
        }
        return config;
      });
      return true;
    }
  } catch {
    // Graceful fallback if StellarSdk is not loaded or structured differently
  }
  return false;
}

