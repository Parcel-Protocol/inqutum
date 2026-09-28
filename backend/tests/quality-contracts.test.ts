import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendChangeHistory, verifyChangeHistory } from '../src/audit/change-history.ts';
import { acquireOptimisticLock, type OptimisticLockStore } from '../src/concurrency/optimistic-lock.ts';
import { buildExport, type ExportRepository } from '../src/exports/export-service.ts';
import { markStepComplete, recoverOperation, startRecovery } from '../src/recovery/recovery-flow.ts';
import { indexSearchEntry, searchIndexEntries, type SearchIndexStore } from '../src/services/search-index.service.ts';
import { createAdapter, type AdapterConfig } from '../src/sandbox/adapters.ts';
import { categorizeError, isRecoverableError, getErrorStatusCode } from '../src/errors/error-taxonomy.ts';
import { processBatch, summarizePartialFailures } from '../src/domain/partial-failures.ts';

describe('optimistic lock contract', () => {
  it('commits when the observed version matches', async () => {
    const versions = new Map([['invoice-1', 3]]);
    const store: OptimisticLockStore = {
      async readVersion(id) { return versions.get(id); },
      async writeVersion(id, expected, next) {
        if (versions.get(id) !== expected) return false;
        versions.set(id, next);
        return true;
      },
    };
    const result = await acquireOptimisticLock(store, { id: 'invoice-1', version: 3 }, 3);
    assert.deepEqual(result, { ok: true, code: 'LOCK_ACQUIRED', nextVersion: 4 });
  });

  it('returns stable stale and dependency outcomes', async () => {
    const stale = await acquireOptimisticLock({
      async readVersion() { return 5; },
      async writeVersion() { return false; },
    }, { id: 'invoice-1', version: 3 }, 3);
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'STALE_VERSION');

    const degraded = await acquireOptimisticLock({
      async readVersion() { throw new Error('down'); },
      async writeVersion() { return false; },
    }, { id: 'invoice-1', version: 3 }, 3);
    assert.equal(degraded.ok, false);
    assert.equal(degraded.code, 'LOCK_STORE_UNAVAILABLE');
    assert.equal(degraded.recoverable, true);
  });
});

describe('export service contract', () => {
  it('exports rows as deterministic csv', async () => {
    const repo: ExportRepository<Record<string, unknown>> = {
      async load() { return [{ b: 'two,2', a: 1 }]; },
    };
    const result = await buildExport(repo, {
      actorId: 'maintainer',
      resource: 'invoices',
      format: 'csv',
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.body, 'a,b\n1,"two,2"');
  });

  it('returns validation and retryable dependency failures', async () => {
    const invalid = await buildExport({ async load() { return []; } }, {
      actorId: '',
      resource: 'invoices',
      format: 'json',
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'EXPORT_INVALID_REQUEST');

    const degraded = await buildExport({ async load() { throw new Error('down'); } }, {
      actorId: 'maintainer',
      resource: 'invoices',
      format: 'json',
    });
    assert.equal(degraded.ok, false);
    assert.equal(degraded.code, 'EXPORT_RETRYABLE_DEPENDENCY');
  });
});

describe('tamper-evident change history', () => {
  it('detects altered and reordered history entries', () => {
    const first = appendChangeHistory([], {
      recordType: 'invoice',
      recordId: 'inv-1',
      actorId: 'seller',
      reason: 'create',
      before: null,
      after: { status: 'PENDING' },
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    });
    const second = appendChangeHistory([first], {
      recordType: 'invoice',
      recordId: 'inv-1',
      actorId: 'seller',
      reason: 'cancel',
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
      occurredAt: new Date('2026-01-01T00:01:00Z'),
    });

    assert.deepEqual(verifyChangeHistory([first, second]), { ok: true });
    assert.equal(verifyChangeHistory([{ ...first, reason: 'edited' }, second]).error, 'HASH_MISMATCH');
    assert.equal(verifyChangeHistory([second, first]).error, 'SEQUENCE_GAP');
  });
});

describe('deterministic recovery flow', () => {
  it('resumes before side effects and fails safe after recorded side effects', () => {
    const steps = [
      { name: 'validate' },
      { name: 'submit-payment-proof', externalSideEffect: true },
      { name: 'notify-seller' },
    ];
    const started = startRecovery('op-1');
    assert.equal(recoverOperation(steps, started).action, 'RESUME');

    const afterValidate = markStepComplete(started, steps[0]);
    assert.equal(recoverOperation(steps, afterValidate).nextStep?.name, 'submit-payment-proof');

    const afterEffect = markStepComplete(afterValidate, steps[1]);
    const replay = { ...afterEffect, currentStep: 1 };
    assert.equal(recoverOperation(steps, replay).action, 'FAIL_SAFE');
  });
});

describe('search index service contract', () => {
  it('indexes valid entries successfully', async () => {
    const store: SearchIndexStore = {
      async indexEntry() { return true; },
      async search() { return []; },
    };
    const result = await indexSearchEntry(store, {
      id: 'inv-1',
      content: 'invoice content',
      timestamp: new Date(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'INDEX_SUCCESS');
  });

  it('returns validation and retryable dependency failures', async () => {
    const invalid = await indexSearchEntry(
      { async indexEntry() { return false; }, async search() { return []; } },
      { id: '', content: 'test', timestamp: new Date() }
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'INDEX_INVALID_INPUT');

    const degraded = await indexSearchEntry(
      { async indexEntry() { throw new Error('down'); }, async search() { return []; } },
      { id: 'inv-1', content: 'test', timestamp: new Date() }
    );
    assert.equal(degraded.ok, false);
    assert.equal(degraded.code, 'INDEX_STORE_UNAVAILABLE');
    assert.equal(degraded.recoverable, true);
  });
});

describe('adapters contract', () => {
  it('creates adapters with valid config', async () => {
    const result = await createAdapter({ type: 'http' });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'ADAPTER_SUCCESS');
  });

  it('returns validation and dependency failures', async () => {
    const invalid = await createAdapter({ type: '' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'ADAPTER_INVALID_CONFIG');

    const unsupported = await createAdapter({ type: 'unknown' });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'ADAPTER_NOT_SUPPORTED');
  });
});

describe('error taxonomy contract', () => {
  it('categorizes errors correctly', () => {
    const validation = categorizeError('VALIDATION_FAILED', 'Invalid input');
    assert.equal(validation.recoverable, false);
    assert.equal(validation.statusCode, 400);

    const unavailable = categorizeError('SERVICE_UNAVAILABLE', 'Service down');
    assert.equal(unavailable.recoverable, true);
    assert.equal(unavailable.statusCode, 503);

    const unknown = categorizeError('UNKNOWN_CODE', 'Unknown error');
    assert.equal(unknown.statusCode, 500);
  });

  it('provides status codes for all error types', () => {
    assert.ok(getErrorStatusCode('VALIDATION_FAILED') >= 400);
    assert.ok(getErrorStatusCode('SERVICE_UNAVAILABLE') >= 500);
  });
});

describe('partial failures contract', () => {
  it('handles successful batch operations', async () => {
    const ops = [
      { id: 'op-1', operation: 'create' },
      { id: 'op-2', operation: 'update' },
    ];
    const result = await processBatch(ops, async (op) => ({
      id: op.id,
      ok: true,
      code: 'SUCCESS',
    }));
    assert.equal(result.code, 'ALL_SUCCESS');
    assert.equal(result.successful, 2);
    assert.equal(result.failed, 0);
  });

  it('distinguishes partial and total failures', async () => {
    const ops = [
      { id: 'op-1', operation: 'create' },
      { id: 'op-2', operation: 'update' },
    ];
    const partialResult = await processBatch(ops, async (op) => ({
      id: op.id,
      ok: op.id === 'op-1',
      code: op.id === 'op-1' ? 'SUCCESS' : 'FAILED',
    }));
    assert.equal(partialResult.code, 'PARTIAL_FAILURE');
    assert.equal(partialResult.successful, 1);
    assert.equal(partialResult.failed, 1);

    const totalFailure = await processBatch(ops, async () => ({
      id: 'test',
      ok: false,
      code: 'ERROR',
    }));
    assert.equal(totalFailure.code, 'TOTAL_FAILURE');
    assert.equal(totalFailure.recoverable, false);
  });

  it('summarizes partial failures correctly', async () => {
    const ops = [{ id: 'op-1', operation: 'test' }];
    const result = await processBatch(ops, async () => ({ id: 'op-1', ok: true, code: 'SUCCESS' }));
    const summary = summarizePartialFailures(result);
    assert.ok(summary.includes('succeeded'));
  });
});
