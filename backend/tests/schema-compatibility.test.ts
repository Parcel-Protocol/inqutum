import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_SCHEMA_VERSION,
  InvalidSchemaRecordError,
  isLegacyRecord,
  versionStamp,
} from '../src/schema/schema-version';
import {
  DEPRECATION_POLICY,
  UnauthorizedSchemaOperationError,
  isWriteAllowed,
  transformForRead,
  transformForWrite,
  validateSchemaCompatibilityBatch,
} from '../src/schema/compatibility';

const BASE_INVOICE = {
  id: '00000000-0000-0000-0000-000000000101',
  sellerPublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP',
  amount: 250,
  assetCode: 'USDC',
  memo: 'QT-COMPAT-1',
  status: 'PENDING' as const,
  version: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
};

describe('Schema compatibility for versioned records (#365)', () => {
  describe('Normal path', () => {
    it('round-trips write -> read at CURRENT_SCHEMA_VERSION without data loss', () => {
      const written = transformForWrite(BASE_INVOICE);
      assert.equal(written._schemaVersion, CURRENT_SCHEMA_VERSION);

      const readBack = transformForRead(written);
      assert.equal(readBack._schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(readBack.id, BASE_INVOICE.id);
      assert.equal(readBack.amount, BASE_INVOICE.amount);
      assert.equal(readBack.assetCode, BASE_INVOICE.assetCode);
      assert.equal(readBack.version, BASE_INVOICE.version);
    });

    it('upgrades legacy unversioned records with safe defaults and preserves existing fields', () => {
      const legacy = {
        id: 'legacy-1',
        sellerPublicKey: BASE_INVOICE.sellerPublicKey,
        amount: 42,
        memo: 'QT-LEGACY',
        createdAt: new Date('2024-05-01T00:00:00.000Z'),
        expiresAt: new Date('2024-05-08T00:00:00.000Z'),
      };

      assert.equal(isLegacyRecord(legacy), true);
      const upgraded = transformForRead(legacy);
      assert.equal(upgraded._schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(upgraded.assetCode, 'XLM');
      assert.equal(upgraded.status, 'PENDING');
      assert.equal(upgraded.version, 1);
    });

    it('keeps DEPRECATION_POLICY buckets disjoint and includes CURRENT_SCHEMA_VERSION in supported', () => {
      const supported = new Set(DEPRECATION_POLICY.supported.versions);
      const deprecated = new Set(DEPRECATION_POLICY.deprecated.versions);
      const unsupported = new Set(DEPRECATION_POLICY.unsupported.versions);

      assert.equal(supported.has(CURRENT_SCHEMA_VERSION), true);
      for (const v of supported) {
        assert.equal(deprecated.has(v), false);
        assert.equal(unsupported.has(v), false);
      }
      for (const v of deprecated) {
        assert.equal(unsupported.has(v), false);
      }
    });

    it('validates mixed legacy and current batches via validateSchemaCompatibilityBatch', () => {
      const report = validateSchemaCompatibilityBatch([
        versionStamp(BASE_INVOICE),
        { id: 'legacy-batch-1', amount: 10 },
      ]);

      assert.equal(report.total, 2);
      assert.equal(report.compatible, 1);
      assert.equal(report.upgraded, 1);
      assert.equal(report.failed, 0);
      assert.deepEqual(report.errors, []);
    });
  });

  describe('Failure path', () => {
    it('rejects unsupported future and unknown schema versions with UNSUPPORTED_SCHEMA_VERSION', () => {
      for (const badVersion of ['99.0', '0.5', '']) {
        assert.throws(
          () => transformForRead({ ...BASE_INVOICE, _schemaVersion: badVersion }),
          (err: any) => err?.code === 'UNSUPPORTED_SCHEMA_VERSION'
        );
      }
    });

    it('rejects malformed non-object records with InvalidSchemaRecordError', () => {
      for (const malformed of [null, [], 'raw-string', 123]) {
        assert.throws(
          () => transformForRead(malformed as any),
          (err: unknown) => err instanceof InvalidSchemaRecordError && err.code === 'INVALID_SCHEMA_RECORD'
        );
      }
    });

    it('isolates per-record compatibility failures in batch validation', () => {
      const report = validateSchemaCompatibilityBatch([
        versionStamp(BASE_INVOICE),
        { ...BASE_INVOICE, _schemaVersion: '99.0' },
        null as any,
      ]);

      assert.equal(report.total, 3);
      assert.equal(report.compatible, 1);
      assert.equal(report.failed, 2);
      assert.equal(report.errors[0]?.index, 1);
      assert.equal(report.errors[0]?.code, 'UNSUPPORTED_SCHEMA_VERSION');
      assert.equal(report.errors[1]?.index, 2);
      assert.equal(report.errors[1]?.code, 'INVALID_SCHEMA_RECORD');
    });
  });

  describe('Retry and idempotency path', () => {
    it('is strictly idempotent across repeated read/write retries without mutating source records', () => {
      const legacy = { id: 'retry-1', amount: 75, memo: 'QT-RETRY' };
      const snapshot = JSON.stringify(legacy);

      const firstRead = transformForRead(legacy);
      const secondRead = transformForRead(firstRead);
      const thirdWrite = transformForWrite(secondRead);
      const fourthRead = transformForRead(thirdWrite);

      assert.equal(JSON.stringify(legacy), snapshot, 'source record must never be mutated');
      assert.deepEqual(secondRead, firstRead);
      assert.deepEqual(fourthRead, firstRead);
    });
  });

  describe('Authorization path', () => {
    it('forbids writes on deprecated versions while allowing writes on supported versions', () => {
      assert.equal(isWriteAllowed('0'), false);
      assert.equal(isWriteAllowed('99.0'), false);
      assert.equal(isWriteAllowed(CURRENT_SCHEMA_VERSION), true);
    });

    it('requires an authorized maintainer/admin actor when requireAuthorization is set', () => {
      assert.throws(
        () =>
          validateSchemaCompatibilityBatch([versionStamp(BASE_INVOICE)], {
            requireAuthorization: true,
            actor: { role: 'viewer', authorized: false },
          }),
        (err: unknown) =>
          err instanceof UnauthorizedSchemaOperationError && err.code === 'UNAUTHORIZED_SCHEMA_OPERATION'
      );

      const ok = validateSchemaCompatibilityBatch([versionStamp(BASE_INVOICE)], {
        requireAuthorization: true,
        actor: { role: 'maintainer' },
      });
      assert.equal(ok.compatible, 1);
      assert.equal(ok.failed, 0);
    });
  });
});
