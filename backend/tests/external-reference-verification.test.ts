import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ExternalReferenceVerificationService,
  type ExternalReferenceInput,
} from '../src/services/external-reference-verification';

const VALID_TX_HASH = 'a1b2c3d4'.repeat(8); // 64 hex chars
const BASE_TIME = new Date('2026-10-18T12:00:00.000Z');

function makeRefInput(overrides: Partial<ExternalReferenceInput> = {}): ExternalReferenceInput {
  return {
    referenceId: 'ref-001',
    referenceType: 'stellar_transaction',
    invoiceId: 'inv-001',
    externalIdentifier: VALID_TX_HASH,
    sourceSystem: 'stellar-horizon-testnet',
    endpoint: 'https://horizon-testnet.stellar.org/transactions/' + VALID_TX_HASH,
    expectedAmount: 150,
    expectedAssetCode: 'XLM',
    ...overrides,
  };
}

describe('Resilient External Reference Verification with Retry Policy', () => {
  it('verifies valid external references and persists timestamp and source metadata (success)', async () => {
    let clockMs = BASE_TIME.getTime();
    const service = new ExternalReferenceVerificationService({
      now: () => new Date(clockMs),
      sleep: async () => {},
    });

    const input = makeRefInput();
    const record = await service.verifyWithRetries(input, async () => {
      clockMs += 45;
      return {
        status: 'verified',
        observedTimestamp: new Date(clockMs - 5_000).toISOString(),
        ledgerSequence: 512_340,
        settledAmount: '150.0000000',
        assetCode: 'XLM',
        rawStatus: 'tx_success',
        schemaVersion: '2.1',
      };
    });

    assert.equal(record.status, 'VERIFIED');
    assert.equal(record.attempts, 1);
    assert.ok(record.verifiedAt);
    assert.equal(record.failure, null);
    assert.ok(record.sourceMetadata);
    assert.equal(record.sourceMetadata.sourceSystem, 'stellar-horizon-testnet');
    assert.equal(record.sourceMetadata.ledgerSequence, 512_340);
    assert.equal(record.sourceMetadata.settledAmount, '150.0000000');
    assert.equal(record.sourceMetadata.assetCode, 'XLM');
    assert.equal(record.sourceMetadata.responseLatencyMs, 45);
    assert.equal(record.sourceMetadata.schemaVersion, '2.1');
    assert.equal(record.attemptHistory.length, 1);
    assert.equal(record.attemptHistory[0].outcome, 'verified');

    // Persisted record can be retrieved by ID and invoiceId
    const persisted = service.getRecord('ref-001');
    assert.deepEqual(persisted, record);
    assert.equal(service.listByInvoice('inv-001').length, 1);
  });

  it('aborts hung external probes at timeoutMs without blocking forever (timeout)', async () => {
    const service = new ExternalReferenceVerificationService({
      timeoutMs: 30,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, backoffFactor: 2, maxDelayMs: 100 },
      now: () => BASE_TIME,
      sleep: async () => {},
    });

    let abortSignalObserved = false;
    const single = await service.verifySingleAttempt(
      makeRefInput({ referenceId: 'ref-timeout-single' }),
      async (_input, signal) => {
        signal.addEventListener('abort', () => {
          abortSignalObserved = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { status: 'verified', observedTimestamp: BASE_TIME.toISOString(), ledgerSequence: 1 };
      }
    );

    assert.equal(abortSignalObserved, true);
    assert.equal(single.status, 'RETRY_SCHEDULED');
    assert.equal(single.attempts, 1);
    assert.ok(single.nextRetryAt);
    assert.equal(single.failure?.code, 'SOURCE_TIMEOUT');
    assert.equal(single.failure?.retryable, true);
    assert.match(single.failure?.recoveryHint ?? '', /timed out/i);
  });

  it('rejects malformed responses and stale data immediately into FAILED_TERMINAL without wasting retries', async () => {
    const service = new ExternalReferenceVerificationService({
      retryPolicy: { maxAttempts: 4, baseDelayMs: 10, backoffFactor: 2, maxDelayMs: 100 },
      maxStalenessMs: 60_000, // 1 minute freshness window
      now: () => BASE_TIME,
      sleep: async () => {},
    });

    // Case 1: Malformed source response (missing observedTimestamp / invalid ledgerSequence)
    let malformedCalls = 0;
    const malformedRecord = await service.verifyWithRetries(
      makeRefInput({ referenceId: 'ref-malformed-1' }),
      async () => {
        malformedCalls += 1;
        return { status: 'verified', observedTimestamp: 'not-a-valid-date' };
      }
    );
    assert.equal(malformedCalls, 1, 'Should not retry deterministic malformed response');
    assert.equal(malformedRecord.status, 'FAILED_TERMINAL');
    assert.equal(malformedRecord.failure?.code, 'MALFORMED_SOURCE_RESPONSE');
    assert.equal(malformedRecord.failure?.retryable, false);

    // Case 2: Stale source data (timestamp older than maxStalenessMs)
    let staleCalls = 0;
    const staleRecord = await service.verifyWithRetries(
      makeRefInput({ referenceId: 'ref-stale-1' }),
      async () => {
        staleCalls += 1;
        return {
          status: 'verified',
          observedTimestamp: new Date(BASE_TIME.getTime() - 10 * 60_000).toISOString(),
          ledgerSequence: 100,
        };
      }
    );
    assert.equal(staleCalls, 1, 'Should not retry stale source data');
    assert.equal(staleRecord.status, 'FAILED_TERMINAL');
    assert.equal(staleRecord.failure?.code, 'STALE_SOURCE_DATA');

    // Case 3: Malformed input reference ID/hash before network call
    let inputCalls = 0;
    const badInputRecord = await service.verifyWithRetries(
      makeRefInput({ referenceId: 'ref-bad-hash', externalIdentifier: 'not-64-hex' }),
      async () => {
        inputCalls += 1;
        return {};
      }
    );
    assert.equal(inputCalls, 0, 'Malformed input must fail before invoking network probe');
    assert.equal(badInputRecord.status, 'FAILED_TERMINAL');
    assert.equal(badInputRecord.failure?.code, 'REFERENCE_MALFORMED_INPUT');
  });

  it('recovers and transitions to VERIFIED when transient failures succeed on retry (retry success)', async () => {
    const backoffDelays: number[] = [];
    const service = new ExternalReferenceVerificationService({
      retryPolicy: { maxAttempts: 4, baseDelayMs: 200, backoffFactor: 2, maxDelayMs: 5000 },
      now: () => BASE_TIME,
      sleep: async (ms) => {
        backoffDelays.push(ms);
      },
    });

    let calls = 0;
    const record = await service.verifyWithRetries(
      makeRefInput({
        referenceId: 'ref-retry-ok',
        referenceType: 'anchor_sep24_transfer',
        externalIdentifier: 'sep24-transfer-998877',
      }),
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('ECONNRESET: upstream socket closed');
        }
        if (calls === 2) {
          return {
            status: 'pending',
            observedTimestamp: BASE_TIME.toISOString(),
          };
        }
        return {
          status: 'verified',
          observedTimestamp: BASE_TIME.toISOString(),
          settledAmount: 150,
          assetCode: 'XLM',
        };
      }
    );

    assert.equal(calls, 3);
    assert.deepEqual(backoffDelays, [200, 400]);
    assert.equal(record.status, 'VERIFIED');
    assert.equal(record.attempts, 3);
    assert.equal(record.failure, null);
    assert.ok(record.verifiedAt);
    assert.deepEqual(
      record.attemptHistory.map((a) => a.outcome),
      ['retry_scheduled', 'retry_scheduled', 'verified']
    );
  });

  it('transitions to FAILED_TERMINAL with RETRY_EXHAUSTED when all retry attempts fail (retry exhaustion)', async () => {
    const backoffDelays: number[] = [];
    const service = new ExternalReferenceVerificationService({
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000 },
      now: () => BASE_TIME,
      sleep: async (ms) => {
        backoffDelays.push(ms);
      },
    });

    let calls = 0;
    const record = await service.verifyWithRetries(
      makeRefInput({ referenceId: 'ref-exhausted' }),
      async () => {
        calls += 1;
        throw new Error('503 Service Unavailable from Horizon');
      }
    );

    assert.equal(calls, 3);
    assert.deepEqual(backoffDelays, [100, 200]);
    assert.equal(record.status, 'FAILED_TERMINAL');
    assert.equal(record.attempts, 3);
    assert.equal(record.verifiedAt, null);
    assert.equal(record.nextRetryAt, null);
    assert.equal(record.failure?.code, 'RETRY_EXHAUSTED');
    assert.equal(record.failure?.rootCauseCode, 'SOURCE_UNREACHABLE');
    assert.equal(record.failure?.retryable, false);
    assert.match(record.failure?.recoveryHint ?? '', /exhausted/i);
    assert.deepEqual(
      record.attemptHistory.map((a) => a.outcome),
      ['retry_scheduled', 'retry_scheduled', 'terminal_failure']
    );
  });
});
