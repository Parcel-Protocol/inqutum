import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalyticsStore, hashActor, hourlyTimeWindow } from '../src/domain/analytics';

test('analytics aggregates events by operation and time window', () => {
  const store = new AnalyticsStore();
  const now = Date.UTC(2026, 8, 29, 12, 0, 0, 0);

  store.record({
    operation: 'invoice_create',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 100,
    actorHash: hashActor('wallet-a'),
  }, now);

  store.record({
    operation: 'invoice_create',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 200,
    actorHash: hashActor('wallet-b'),
  }, now);

  store.record({
    operation: 'invoice_create',
    status: 'failure',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 300,
    actorHash: hashActor('wallet-a'),
    errorCode: 'QUOTA_EXCEEDED',
  }, now);

  const summary = store.query({ nowMs: now });
  assert.equal(summary.totalEvents, 3);
  assert.equal(summary.aggregates.length, 1);

  const agg = summary.aggregates[0];
  assert.equal(agg.operation, 'invoice_create');
  assert.equal(agg.totalRequests, 3);
  assert.equal(agg.successCount, 2);
  assert.equal(agg.failureCount, 1);
  assert.equal(agg.successRate, 2 / 3);
  assert.equal(agg.p50LatencyMs, 200);
  assert.equal(agg.p95LatencyMs, 300);
  assert.equal(agg.uniqueActors, 2);
  assert.equal(agg.topErrorCodes.length, 1);
  assert.equal(agg.topErrorCodes[0].code, 'QUOTA_EXCEEDED');
  assert.equal(agg.topErrorCodes[0].count, 1);
});

test('analytics separates events by time window', () => {
  const store = new AnalyticsStore();
  const hour1 = Date.UTC(2026, 8, 29, 12, 0, 0, 0);
  const hour2 = Date.UTC(2026, 8, 29, 13, 0, 0, 0);

  store.record({
    operation: 'horizon_verify',
    status: 'success',
    timeWindow: hourlyTimeWindow(hour1),
    latencyMs: 50,
    actorHash: hashActor('wallet-a'),
  }, hour1);

  store.record({
    operation: 'horizon_verify',
    status: 'success',
    timeWindow: hourlyTimeWindow(hour2),
    latencyMs: 60,
    actorHash: hashActor('wallet-a'),
  }, hour2);

  const summary = store.query({ nowMs: hour2 + 1000 });
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.aggregates.length, 2);
});

test('analytics respects retention window', () => {
  const store = new AnalyticsStore(1); // 1 hour retention
  const now = Date.UTC(2026, 8, 29, 12, 0, 0, 0);
  const twoHoursLater = now + 2 * 60 * 60 * 1000;

  store.record({
    operation: 'email_enqueue',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 100,
    actorHash: hashActor('wallet-a'),
  }, now);

  // After retention window expires, the bucket should be evicted
  store.record({
    operation: 'email_enqueue',
    status: 'success',
    timeWindow: hourlyTimeWindow(twoHoursLater),
    latencyMs: 100,
    actorHash: hashActor('wallet-a'),
  }, twoHoursLater);

  const summary = store.query({ nowMs: twoHoursLater + 1000 });
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.aggregates.length, 1);
  assert.equal(summary.aggregates[0].timeWindow, hourlyTimeWindow(twoHoursLater));
});

test('analytics does not store raw actor identities', () => {
  const store = new AnalyticsStore();
  const now = Date.UTC(2026, 8, 29, 12, 0, 0, 0);

  store.record({
    operation: 'search_index',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 100,
    actorHash: hashActor('sensitive-wallet-address-GABC123'),
  }, now);

  const summary = store.query({ nowMs: now });
  const agg = summary.aggregates[0];

  // Only the hash is stored, never the raw identity
  assert.equal(agg.uniqueActors, 1);
  // No raw identity in any field
  const json = JSON.stringify(agg);
  assert.equal(json.includes('sensitive-wallet-address'), false);
  assert.equal(json.includes('GABC123'), false);
});

test('analytics clear removes all data', () => {
  const store = new AnalyticsStore();
  const now = Date.UTC(2026, 8, 29, 12, 0, 0, 0);

  store.record({
    operation: 'invoice_create',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 100,
    actorHash: hashActor('wallet-a'),
  }, now);

  assert.equal(store.bucketCount, 1);
  store.clear();
  assert.equal(store.bucketCount, 0);

  const summary = store.query({ nowMs: now });
  assert.equal(summary.totalEvents, 0);
  assert.equal(summary.aggregates.length, 0);
});

test('analytics filters by operation', () => {
  const store = new AnalyticsStore();
  const now = Date.UTC(2026, 8, 29, 12, 0, 0, 0);

  store.record({
    operation: 'invoice_create',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 100,
    actorHash: hashActor('wallet-a'),
  }, now);

  store.record({
    operation: 'horizon_verify',
    status: 'success',
    timeWindow: hourlyTimeWindow(now),
    latencyMs: 200,
    actorHash: hashActor('wallet-a'),
  }, now);

  const summary = store.query({ operation: 'invoice_create', nowMs: now });
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.aggregates.length, 1);
  assert.equal(summary.aggregates[0].operation, 'invoice_create');
});

test('hashActor produces consistent one-way hashes', () => {
  const hash1 = hashActor('wallet-a');
  const hash2 = hashActor('wallet-a');
  const hash3 = hashActor('wallet-b');

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
  // Hash is a 16-character hex string
  assert.match(hash1, /^[a-f0-9]{16}$/);
});

test('hourlyTimeWindow truncates to the hour', () => {
  const ts = Date.UTC(2026, 8, 29, 14, 35, 42, 123);
  const window = hourlyTimeWindow(ts);
  assert.equal(window, '2026-09-29T14:00:00.000Z');
});
