/**
 * Compatibility transforms for versioned invoice records.
 *
 * Read path: normalise any record (legacy or current) to the latest shape.
 * Write path: ensure every persisted record carries the schema version.
 *
 * When a new schema version is introduced:
 *   1. Bump CURRENT_SCHEMA_VERSION in schema-version.ts.
 *   2. Add a transform in UPGRADE_TRANSFORMS from the old version to the new one.
 *   3. Move the old version into DEPRECATION_POLICY.deprecated (and eventually unsupported).
 */

import type { StoredInvoice } from '../storage/invoice-storage';
import {
  CURRENT_SCHEMA_VERSION,
  isLegacyRecord,
  versionStamp,
  type SchemaVersion,
  type VersionedRecord,
} from './schema-version';

/**
 * Documents which versions are still accepted, which are deprecated (read-only
 * with warnings), and which are outright rejected.
 */
export const DEPRECATION_POLICY: Record<
  'supported' | 'deprecated' | 'unsupported',
  { versions: SchemaVersion[]; note: string }
> = {
  supported: {
    versions: [CURRENT_SCHEMA_VERSION],
    note: 'Fully supported. Records read and written as-is.',
  },
  deprecated: {
    versions: ['0'],
    note: 'Legacy records created before versioning. Upgraded on read to the current schema.',
  },
  unsupported: {
    versions: [],
    note: 'Records from these versions cannot be processed. Contact maintainers for migration help.',
  },
};

/** Per-version upgrade functions. Each one transforms a record from `fromVersion` to the next. */
type UpgradeTransform = (record: Record<string, unknown>) => Record<string, unknown>;

const UPGRADE_TRANSFORMS: Record<SchemaVersion, { to: SchemaVersion; transform: UpgradeTransform }> = {
  '0': {
    to: '1.0',
    transform: (record) => ({
      ...record,
      // Fields that may be absent on truly old rows get safe defaults.
      assetCode: record.assetCode ?? 'XLM',
      status: record.status ?? 'PENDING',
      version: record.version ?? 1,
    }),
  },
};

function effectiveVersion(record: Record<string, unknown>): SchemaVersion {
  if (isLegacyRecord(record)) return '0';
  return String(record._schemaVersion);
}

function isSupportedOrDeprecated(version: SchemaVersion): boolean {
  return (
    DEPRECATION_POLICY.supported.versions.includes(version) ||
    DEPRECATION_POLICY.deprecated.versions.includes(version)
  );
}

/**
 * Normalise a record (from storage or an older client) to the current schema.
 *
 * - Legacy / unversioned records are upgraded through the transform chain.
 * - Records at the current version pass through.
 * - Unsupported versions throw a structured error.
 */
export function transformForRead(
  record: Record<string, unknown>,
  fromVersion?: SchemaVersion
): VersionedRecord<StoredInvoice> {
  let version = fromVersion ?? effectiveVersion(record);

  if (!isSupportedOrDeprecated(version)) {
    const err: any = new Error(
      `Schema version "${version}" is not supported. Supported: ${DEPRECATION_POLICY.supported.versions.join(', ')}. ` +
        `Deprecated (read-only): ${DEPRECATION_POLICY.deprecated.versions.join(', ') || 'none'}.`
    );
    err.code = 'UNSUPPORTED_SCHEMA_VERSION';
    throw err;
  }

  let current = { ...record };

  // Walk the upgrade chain until we reach the current version.
  while (version !== CURRENT_SCHEMA_VERSION) {
    const step = UPGRADE_TRANSFORMS[version];
    if (!step) {
      const err: any = new Error(`No upgrade path from schema version "${version}".`);
      err.code = 'UNSUPPORTED_SCHEMA_VERSION';
      throw err;
    }
    current = step.transform(current);
    version = step.to;
  }

  return versionStamp(current) as unknown as VersionedRecord<StoredInvoice>;
}

/**
 * Ensure a write payload carries the current schema version.
 */
export function transformForWrite<T extends Record<string, unknown>>(input: T): T & { _schemaVersion: SchemaVersion } {
  return { ...input, _schemaVersion: CURRENT_SCHEMA_VERSION };
}

/**
 * Returns true only when writes are permitted for the given schema version.
 * Deprecated versions are read-only and cannot be written.
 */
export function isWriteAllowed(version: SchemaVersion): boolean {
  return DEPRECATION_POLICY.supported.versions.includes(version);
}

export class UnauthorizedSchemaOperationError extends Error {
  readonly code = 'UNAUTHORIZED_SCHEMA_OPERATION';

  constructor(message = 'Actor is not authorized to perform schema compatibility verification') {
    super(message);
    this.name = 'UnauthorizedSchemaOperationError';
  }
}

export interface SchemaCompatibilityError {
  index: number;
  code: string;
  error: string;
}

export interface SchemaCompatibilityReport {
  total: number;
  compatible: number;
  upgraded: number;
  failed: number;
  errors: SchemaCompatibilityError[];
}

const AUTHORIZED_SCHEMA_ROLES = new Set(['admin', 'maintainer', 'ops']);

/**
 * Validates a batch of versioned or legacy records against the read compatibility chain.
 */
export function validateSchemaCompatibilityBatch(
  records: Array<Record<string, unknown>>,
  options: {
    requireAuthorization?: boolean;
    actor?: { role?: string; authorized?: boolean };
  } = {}
): SchemaCompatibilityReport {
  if (options.requireAuthorization) {
    const actor = options.actor;
    const ok = Boolean(
      actor && (actor.authorized === true || (actor.role && AUTHORIZED_SCHEMA_ROLES.has(actor.role)))
    );
    if (!ok) {
      throw new UnauthorizedSchemaOperationError();
    }
  }

  let compatible = 0;
  let upgraded = 0;
  const errors: SchemaCompatibilityError[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      const legacy = isLegacyRecord(record);
      const normalized = transformForRead(record);
      if (normalized._schemaVersion !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`Normalized version mismatch: ${normalized._schemaVersion}`);
      }
      if (legacy) {
        upgraded += 1;
      } else {
        compatible += 1;
      }
    } catch (err: any) {
      errors.push({
        index: i,
        code: typeof err?.code === 'string' ? err.code : 'SCHEMA_COMPATIBILITY_ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    total: records.length,
    compatible,
    upgraded,
    failed: errors.length,
    errors,
  };
}
