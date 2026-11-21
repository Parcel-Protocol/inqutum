/**
 * Real probes for the dependency degradation matrix (#381).
 *
 * Each factory returns a `DependencyProbe`. Probes report failure by returning
 * `{ ok: false, error }` instead of throwing, and take their I/O as a parameter
 * so tests never touch the network or a database. Probe error text is redacted
 * by `evaluateDependency` before it can leave the process.
 */

import type { DependencyProbe } from './dependency-degradation';

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** Horizon's root document is cheap and unauthenticated. */
export function horizonProbe(
  horizonUrl: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): DependencyProbe {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? 4000;
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(horizonUrl, { signal: controller.signal });
      const latencyMs = Date.now() - started;
      return response.ok ? { ok: true, latencyMs } : { ok: false, latencyMs, error: `Horizon responded ${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, latencyMs: Date.now() - started, error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : message };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `SELECT 1` through any pg-shaped pool. */
export function postgresProbe(pool: { query: (sql: string) => Promise<unknown> }): DependencyProbe {
  return async () => {
    const started = Date.now();
    try {
      await pool.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
