import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTimelineCursorError, buildActivityTimeline } from '../src/domain/activity-timeline.ts';
import type { TimelineEvent, TimelineInvoice } from '../src/domain/activity-timeline.ts';

const SELLER = 'G' + 'A'.repeat(55);
const OTHER = 'G' + 'B'.repeat(55);
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const owner = { role: 'end_user' as const, wallet: SELLER };
const stranger = { role: 'end_user' as const, wallet: OTHER };
const anonymous = { role: 'anonymous' as const };

const invoices: TimelineInvoice[] = [
  { id: 'inv-1', sellerPublicKey: SELLER },
  { id: 'inv-gone', sellerPublicKey: SELLER, deleted: true },
  { id: 'inv-locked', sellerPublicKey: SELLER, restricted: true },
];

const event = (id: string, invoiceId: string, eventType: string, minutes: number): TimelineEvent => ({
  id,
  invoiceId,
  eventType,
  eventData: { amount: '10', assetCode: 'XLM', txHash: 'a'.repeat(64) },
  createdAt: at(minutes),
});

const events: TimelineEvent[] = [
  event('e1', 'inv-1', 'INVOICE_CREATED', 0),
  event('e2', 'inv-1', 'PAYMENT_CONFIRMED', 5),
  event('e3', 'inv-1', 'PAYMENT_REJECTED', 6),
  event('g1', 'inv-gone', 'INVOICE_CREATED', 1),
  event('l1', 'inv-locked', 'INVOICE_CREATED', 2),
  event('m1', 'missing', 'INVOICE_CREATED', 3),
];

describe('activity timeline authorization: failure paths', () => {
  it('an authorized non-owner wallet sees none of the owner events', () => {
    const page = buildActivityTimeline(stranger, events, invoices);
    assert.deepEqual(page.entries, []);
    assert.equal(page.nextCursor, null);
  });

  it('a wrong-wallet caller gets the same page as an anonymous caller', () => {
    assert.deepEqual(buildActivityTimeline(stranger, events, invoices), buildActivityTimeline(anonymous, events, invoices));
  });

  it('hidden, restricted, deleted and missing invoices all look the same to the owner (no existence leak)', () => {
    const hidden = buildActivityTimeline(owner, [events[3]], invoices);
    const restricted = buildActivityTimeline(owner, [events[4]], invoices);
    const missing = buildActivityTimeline(owner, [events[5]], invoices);
    assert.deepEqual(hidden, { entries: [], nextCursor: null });
    assert.deepEqual(restricted, hidden);
    assert.deepEqual(missing, hidden);
  });

  it('a cursor issued to the owner yields nothing when replayed by another wallet', () => {
    const first = buildActivityTimeline(owner, events, invoices, { limit: 1 });
    assert.ok(first.nextCursor);
    const replay = buildActivityTimeline(stranger, events, invoices, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(replay.entries, []);
    assert.equal(replay.nextCursor, null);
  });

  it('rejects a cursor that is not valid base64url JSON', () => {
    assert.throws(() => buildActivityTimeline(owner, events, invoices, { cursor: '%%%' }), InvalidTimelineCursorError);
  });
});

describe('activity timeline authorization: normal and hidden-versus-visible paths', () => {
  it('the owner sees their public events and not the maintainer-only one', () => {
    const page = buildActivityTimeline(owner, events, invoices);
    assert.deepEqual(page.entries.map((e) => e.id), ['e2', 'e1']);
  });

  it('restricting one invoice hides only that invoice from the owner', () => {
    const page = buildActivityTimeline(owner, [events[0], events[4]], invoices);
    assert.deepEqual(page.entries.map((e) => e.invoiceId), ['inv-1']);
  });
});

describe('activity timeline authorization: retry paths', () => {
  it('repeating the same request returns an identical page', () => {
    const a = buildActivityTimeline(owner, events, invoices, { limit: 2 });
    const b = buildActivityTimeline(owner, events, invoices, { limit: 2 });
    assert.deepEqual(a, b);
  });

  it('re-requesting the same cursor returns the same next page', () => {
    const first = buildActivityTimeline(owner, events, invoices, { limit: 1 });
    const again = buildActivityTimeline(owner, events, invoices, { limit: 1, cursor: first.nextCursor });
    const retry = buildActivityTimeline(owner, events, invoices, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(again, retry);
  });

  it('a retry after the owner loses access gives the stranger view, not stale owner data', () => {
    const before = buildActivityTimeline(owner, events, invoices);
    const after = buildActivityTimeline(stranger, events, invoices);
    assert.equal(before.entries.length > 0, true);
    assert.deepEqual(after.entries, []);
  });
});

describe('activity timeline authorization: limits', () => {
  it('clamps a non-positive limit to one entry and never returns more than the maximum', () => {
    assert.equal(buildActivityTimeline(owner, events, invoices, { limit: 0 }).entries.length, 1);
    assert.equal(buildActivityTimeline(owner, events, invoices, { limit: 10_000 }).entries.length, 2);
  });
});
