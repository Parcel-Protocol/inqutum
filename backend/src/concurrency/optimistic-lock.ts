export type OptimisticLockCode =
  | 'LOCK_ACQUIRED'
  | 'STALE_VERSION'
  | 'INVALID_EXPECTED_VERSION'
  | 'LOCK_STORE_UNAVAILABLE';

export type OptimisticLockResult =
  | { ok: true; code: 'LOCK_ACQUIRED'; nextVersion: number }
  | { ok: false; code: Exclude<OptimisticLockCode, 'LOCK_ACQUIRED'>; message: string; recoverable: boolean };

export interface VersionedRecord {
  id: string;
  version: number;
}

export interface OptimisticLockStore {
  readVersion(id: string): Promise<number | undefined>;
  writeVersion(id: string, expectedVersion: number, nextVersion: number): Promise<boolean>;
}

export async function acquireOptimisticLock(
  store: OptimisticLockStore,
  record: VersionedRecord,
  expectedVersion: number
): Promise<OptimisticLockResult> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return {
      ok: false,
      code: 'INVALID_EXPECTED_VERSION',
      message: 'Expected version must be a non-negative integer.',
      recoverable: false,
    };
  }

  try {
    const currentVersion = await store.readVersion(record.id);
    const observedVersion = currentVersion ?? record.version;
    if (observedVersion !== expectedVersion) {
      return {
        ok: false,
        code: 'STALE_VERSION',
        message: 'Record changed before the operation could be committed.',
        recoverable: true,
      };
    }

    const nextVersion = expectedVersion + 1;
    const committed = await store.writeVersion(record.id, expectedVersion, nextVersion);
    if (!committed) {
      return {
        ok: false,
        code: 'STALE_VERSION',
        message: 'Record changed during optimistic lock commit.',
        recoverable: true,
      };
    }

    return { ok: true, code: 'LOCK_ACQUIRED', nextVersion };
  } catch {
    return {
      ok: false,
      code: 'LOCK_STORE_UNAVAILABLE',
      message: 'Optimistic lock store is unavailable; retry later.',
      recoverable: true,
    };
  }
}
