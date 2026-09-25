import { IDEMPOTENCY_TOMBSTONE_MS } from './store';
import type { BeginInput, BeginResult, IdempotencyStore, StoredResponse } from './store';

interface Entry {
  fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response?: StoredResponse;
  lockedUntil: number;
  expiresAt: number;
}

/** Bounds memory: past this many keys the oldest completed ones are dropped. */
const MAX_ENTRIES = 5000;

/**
 * In-process store for the memory MVP server and tests.
 *
 * Every method decides and writes without an `await` in between, so two
 * concurrent requests in one process cannot both be told `new`. It shares
 * nothing across processes and forgets on restart; the Postgres store is the
 * durable form of the same contract.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  private id(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  async begin(input: BeginInput): Promise<BeginResult> {
    const id = this.id(input.scope, input.key);
    const now = input.now.getTime();
    const existing = this.entries.get(id);

    if (!existing) {
      this.entries.set(id, {
        fingerprint: input.fingerprint,
        status: 'IN_PROGRESS',
        lockedUntil: now + input.lockMs,
        expiresAt: now + input.ttlMs,
      });
      this.evictIfFull();
      return { kind: 'new' };
    }

    if (existing.expiresAt <= now) return { kind: 'expired' };
    if (existing.fingerprint !== input.fingerprint) return { kind: 'conflict' };
    if (existing.status === 'COMPLETED') return { kind: 'replay', response: existing.response! };

    if (existing.lockedUntil > now) return { kind: 'in_progress' };
    // The owner never finished (crashed, or hung past the lock): take over.
    existing.lockedUntil = now + input.lockMs;
    return { kind: 'new' };
  }

  async complete(scope: string, key: string, response: StoredResponse): Promise<void> {
    const entry = this.entries.get(this.id(scope, key));
    if (entry) {
      entry.status = 'COMPLETED';
      entry.response = response;
    }
  }

  async release(scope: string, key: string): Promise<void> {
    const id = this.id(scope, key);
    if (this.entries.get(id)?.status === 'IN_PROGRESS') this.entries.delete(id);
  }

  async purge(now: Date): Promise<number> {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt + IDEMPOTENCY_TOMBSTONE_MS <= now.getTime()) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  private evictIfFull(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [id, entry] of this.entries) {
      if (entry.status === 'COMPLETED') {
        this.entries.delete(id);
        return;
      }
    }
  }
}
