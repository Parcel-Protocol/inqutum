import { createHash } from 'node:crypto';

export interface CriticalChangeInput {
  recordType: string;
  recordId: string;
  actorId: string;
  reason: string;
  before: unknown;
  after: unknown;
  occurredAt?: Date;
}

export interface CriticalChangeRecord extends CriticalChangeInput {
  sequence: number;
  occurredAt: Date;
  previousHash: string;
  hash: string;
}

export function appendChangeHistory(
  history: CriticalChangeRecord[],
  input: CriticalChangeInput
): CriticalChangeRecord {
  const sequence = history.length + 1;
  const previousHash = history.length > 0 ? history[history.length - 1]?.hash ?? 'GENESIS' : 'GENESIS';
  const occurredAt = input.occurredAt ?? new Date();
  const recordWithoutHash = { ...input, sequence, previousHash, occurredAt };
  const hash = hashChange(recordWithoutHash);
  return { ...recordWithoutHash, hash };
}

export function verifyChangeHistory(history: CriticalChangeRecord[]): {
  ok: boolean;
  error?: 'HASH_MISMATCH' | 'CHAIN_GAP' | 'SEQUENCE_GAP';
  index?: number;
} {
  let previousHash = 'GENESIS';
  for (let index = 0; index < history.length; index += 1) {
    const record = history[index];
    if (record.sequence !== index + 1) return { ok: false, error: 'SEQUENCE_GAP', index };
    if (record.previousHash !== previousHash) return { ok: false, error: 'CHAIN_GAP', index };
    const { hash, ...rest } = record;
    if (hashChange(rest) !== hash) return { ok: false, error: 'HASH_MISMATCH', index };
    previousHash = hash;
  }
  return { ok: true };
}

function hashChange(record: Omit<CriticalChangeRecord, 'hash'>): string {
  return createHash('sha256')
    .update(stableStringify({
      ...record,
      occurredAt: record.occurredAt.toISOString(),
    }))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
