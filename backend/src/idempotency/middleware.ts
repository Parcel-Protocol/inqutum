import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ANONYMOUS_ACTOR } from '../auth/actor';
import { sendFailure } from '../types/api';
import {
  DEFAULT_IDEMPOTENCY_LOCK_MS,
  DEFAULT_IDEMPOTENCY_TTL_MS,
} from './store';
import type { IdempotencyStore } from './store';

/** 8 to 255 characters from a URL-safe alphabet; a UUID always qualifies. */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /** When true a request without a key is refused instead of run unprotected. */
  required?: () => boolean;
  ttlMs?: () => number;
  lockMs?: () => number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** JSON with object keys sorted, so equal requests hash equally however the client ordered them. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`);
  return `{${entries.join(',')}}`;
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${canonicalJson(body ?? null)}`).digest('hex');
}

const envMs = (name: string, seconds: number) => () => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : seconds * 1000;
};

/**
 * Makes a write safe to retry. Put it after authentication (it scopes keys to
 * the actor) and before rate limits and ceilings, so a replay of a request that
 * already succeeded is answered from the store even when the system has since
 * become busy or full.
 *
 * Outcomes are described in ./store.ts; the HTTP mapping is:
 *
 *   replay       the stored status and body, plus `Idempotent-Replayed: true`
 *   in_progress  409 IDEMPOTENCY_IN_PROGRESS  (+ Retry-After)
 *   conflict     422 IDEMPOTENCY_KEY_CONFLICT
 *   expired      410 IDEMPOTENCY_KEY_EXPIRED
 *   bad key      400 IDEMPOTENCY_KEY_INVALID / IDEMPOTENCY_KEY_REQUIRED
 *   store down   503 IDEMPOTENCY_STORE_UNAVAILABLE (fail closed: running the
 *                write unprotected would defeat the guarantee the client asked for)
 */
export function idempotency(options: IdempotencyOptions): RequestHandler {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const required =
    options.required ?? (() => process.env.REQUIRE_IDEMPOTENCY_KEY === 'true');
  const ttlMs = options.ttlMs ?? (() => envMs('IDEMPOTENCY_TTL_SECONDS', DEFAULT_IDEMPOTENCY_TTL_MS / 1000)());
  const lockMs = options.lockMs ?? (() => envMs('IDEMPOTENCY_LOCK_SECONDS', DEFAULT_IDEMPOTENCY_LOCK_MS / 1000)());

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('idempotency-key');

    if (header === undefined) {
      if (required()) {
        return sendFailure(res, 400, 'An Idempotency-Key header is required for this request', 'IDEMPOTENCY_KEY_REQUIRED');
      }
      return next();
    }
    if (!KEY_PATTERN.test(header)) {
      return sendFailure(
        res,
        400,
        'Idempotency-Key must be 8 to 255 characters from A-Z a-z 0-9 _ . : - (a UUID works)',
        'IDEMPOTENCY_KEY_INVALID'
      );
    }

    const key = header;
    const scope = (req.actor ?? ANONYMOUS_ACTOR).subject;
    const fingerprint = requestFingerprint(req.method, req.originalUrl.split('?')[0], req.body);
    res.setHeader('Idempotency-Key', key);

    let decision;
    try {
      decision = await store.begin({
        scope,
        key,
        fingerprint,
        now: now(),
        ttlMs: ttlMs(),
        lockMs: lockMs(),
      });
    } catch (error: any) {
      console.error('Idempotency store unavailable:', error?.message || error);
      res.setHeader('Retry-After', '5');
      return sendFailure(res, 503, 'Idempotency store unavailable; retry shortly', 'IDEMPOTENCY_STORE_UNAVAILABLE');
    }

    switch (decision.kind) {
      case 'replay':
        res.setHeader('Idempotent-Replayed', 'true');
        return void res.status(decision.response.status).json(decision.response.body);
      case 'in_progress':
        res.setHeader('Retry-After', '1');
        return sendFailure(
          res,
          409,
          'A request with this Idempotency-Key is still being processed',
          'IDEMPOTENCY_IN_PROGRESS'
        );
      case 'conflict':
        return sendFailure(
          res,
          422,
          'This Idempotency-Key was already used for a different request',
          'IDEMPOTENCY_KEY_CONFLICT'
        );
      case 'expired':
        return sendFailure(
          res,
          410,
          'This Idempotency-Key has expired; send the request again with a new key',
          'IDEMPOTENCY_KEY_EXPIRED'
        );
      case 'new':
        break;
    }

    // This request owns the key. Record a success before the response leaves, so
    // a client that retries the instant it reads the reply finds it stored;
    // anything else releases the key so the retry runs again.
    let settled = false;
    const originalJson = res.json.bind(res);
    res.json = (body?: unknown) => {
      if (settled) return originalJson(body);
      settled = true;

      const status = res.statusCode;
      const outcome =
        status >= 200 && status < 300
          ? store.complete(scope, key, { status, body: JSON.parse(JSON.stringify(body ?? null)) }, now())
          : store.release(scope, key);
      outcome
        .catch((error) => console.error('Idempotency bookkeeping failed:', error?.message || error))
        .finally(() => originalJson(body));
      return res;
    };

    // The client went away, or the handler threw, before any reply was sent.
    res.once('close', () => {
      if (settled) return;
      settled = true;
      store.release(scope, key).catch(() => undefined);
    });

    next();
  };
}

export default idempotency;
