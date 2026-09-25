import { pool } from '../config/database';
import { IDEMPOTENCY_TOMBSTONE_MS } from './store';
import type { BeginInput, BeginResult, IdempotencyStore, StoredResponse } from './store';

/** Minimal database surface (a pg Pool, or a test double). */
export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * Durable store backed by the `idempotency_keys` table (db/schema.sql).
 *
 * The atomic step is `INSERT ... ON CONFLICT DO NOTHING`: exactly one of two
 * concurrent first requests inserts the row and is told `new`; the other reads
 * what is there. Taking over an abandoned attempt is a conditional UPDATE, so
 * two waiters cannot both take the same stale lock.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private begins = 0;

  constructor(private readonly db: Queryable = pool) {}

  async begin(input: BeginInput): Promise<BeginResult> {
    const now = input.now;
    const inserted = await this.db.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, locked_until, expires_at)
       VALUES ($1, $2, $3, 'IN_PROGRESS', $4, $5)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING key`,
      [
        input.scope,
        input.key,
        input.fingerprint,
        new Date(now.getTime() + input.lockMs),
        new Date(now.getTime() + input.ttlMs),
      ]
    );
    this.maybePurge(now);
    if (inserted.rows.length > 0) return { kind: 'new' };

    const found = await this.db.query(
      `SELECT request_hash, status, response_status, response_body, locked_until, expires_at
       FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [input.scope, input.key]
    );
    const row = found.rows[0];
    // Deleted between the insert and the select (a purge, or a release by the
    // owner): the key is free again, so ask once more.
    if (!row) return this.begin(input);

    if (new Date(row.expires_at).getTime() <= now.getTime()) return { kind: 'expired' };
    if (row.request_hash !== input.fingerprint) return { kind: 'conflict' };
    if (row.status === 'COMPLETED') {
      return {
        kind: 'replay',
        response: { status: Number(row.response_status), body: row.response_body },
      };
    }
    if (new Date(row.locked_until).getTime() > now.getTime()) return { kind: 'in_progress' };

    const takenOver = await this.db.query(
      `UPDATE idempotency_keys SET locked_until = $3
       WHERE scope = $1 AND key = $2 AND status = 'IN_PROGRESS' AND locked_until <= $4
       RETURNING key`,
      [input.scope, input.key, new Date(now.getTime() + input.lockMs), now]
    );
    return takenOver.rows.length > 0 ? { kind: 'new' } : { kind: 'in_progress' };
  }

  async complete(scope: string, key: string, response: StoredResponse): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', response_status = $3, response_body = $4::jsonb, locked_until = NULL
       WHERE scope = $1 AND key = $2`,
      [scope, key, response.status, JSON.stringify(response.body)]
    );
  }

  async release(scope: string, key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
      [scope, key]
    );
  }

  async purge(now: Date): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM idempotency_keys WHERE expires_at < $1`,
      [new Date(now.getTime() - IDEMPOTENCY_TOMBSTONE_MS)]
    );
    return result.rowCount ?? 0;
  }

  /** Housekeeping rides on ordinary traffic so no scheduler is needed. */
  private maybePurge(now: Date): void {
    this.begins += 1;
    if (this.begins % 200 !== 0) return;
    this.purge(now).catch((error) => console.error('Idempotency purge failed:', error?.message || error));
  }
}

export default PostgresIdempotencyStore;
