import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  InvalidTransitionError,
  allowedTransitions,
  assertTransition,
  canTransition,
  describeLifecycle,
  isTerminalStatus,
  nextStatus,
} from '../../shared/invoice-lifecycle.ts';
import type { InvoiceEvent, InvoiceStatus } from '../../shared/invoice-lifecycle.ts';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers.ts';
import { InvoiceService } from '../src/services/invoice.service.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { PostgresInvoiceStorage } from '../src/storage/postgres-invoice-storage.ts';
import type { InvoiceStorage } from '../src/storage/invoice-storage.ts';
import { FakeInvoiceDb } from './fixtures/fake-invoice-db.fixture.ts';

// The code under test logs every request and every rejected call. That output is
// noise here and, at volume, makes the node:test runner's IPC stream flaky
// ("Unable to deserialize cloned data"), so this file keeps it quiet.
for (const method of ['log', 'warn', 'error'] as const) {
  console[method] = () => undefined;
}

const SELLER = 'G' + 'A'.repeat(55);
const OTHER_SELLER = 'G' + 'B'.repeat(55);
const PAYER = 'G' + 'C'.repeat(55);
const tx = (char: string) => char.repeat(64);

const ALL_EVENTS: InvoiceEvent[] = ['SETTLE', 'SETTLE_AFTER_CANCEL', 'CANCEL', 'EXPIRE'];

// The whole machine, written out independently of INVOICE_TRANSITIONS so the
// table cannot pass by being compared with itself.
const EXPECTED: Record<InvoiceStatus, Partial<Record<InvoiceEvent, InvoiceStatus>>> = {
  PENDING: { SETTLE: 'PAID', CANCEL: 'CANCELLED', EXPIRE: 'EXPIRED' },
  PAID: {},
  EXPIRED: {},
  CANCELLED: { SETTLE_AFTER_CANCEL: 'PAID' },
};

describe('invoice lifecycle model', () => {
  for (const status of INVOICE_STATUSES) {
    for (const event of ALL_EVENTS) {
      const expected = EXPECTED[status][event] ?? null;
      it(`${status} + ${event} -> ${expected ?? 'rejected'}`, () => {
        assert.equal(nextStatus(status, event), expected);
        if (expected) {
          assert.equal(assertTransition(status, event), expected);
        } else {
          assert.throws(
            () => assertTransition(status, event),
            (error: unknown) => {
              assert.ok(error instanceof InvalidTransitionError);
              assert.equal(error.code, 'INVALID_TRANSITION');
              assert.equal(error.from, status);
              assert.equal(error.event, event);
              return true;
            }
          );
        }
      });
    }
  }

  it('lists exactly the allowed transitions and nothing else', () => {
    const listed = INVOICE_TRANSITIONS.map((t) => `${t.from}:${t.event}:${t.to}`).sort();
    const expected = Object.entries(EXPECTED)
      .flatMap(([from, events]) => Object.entries(events).map(([event, to]) => `${from}:${event}:${to}`))
      .sort();
    assert.deepEqual(listed, expected);
  });

  it('canTransition and allowedTransitions agree with the table', () => {
    assert.deepEqual(allowedTransitions('PENDING').sort(), ['CANCELLED', 'EXPIRED', 'PAID']);
    assert.deepEqual(allowedTransitions('CANCELLED'), ['PAID']);
    assert.deepEqual(allowedTransitions('PAID'), []);
    assert.deepEqual(allowedTransitions('EXPIRED'), []);
    assert.deepEqual(allowedTransitions('NOT_A_STATUS'), []);
    assert.equal(canTransition('PENDING', 'PAID'), true);
    assert.equal(canTransition('PAID', 'PENDING'), false);
    assert.equal(canTransition('EXPIRED', 'PAID'), false);
  });

  it('marks only PAID and EXPIRED as terminal', () => {
    assert.equal(isTerminalStatus('PAID'), true);
    assert.equal(isTerminalStatus('EXPIRED'), true);
    assert.equal(isTerminalStatus('PENDING'), false);
    assert.equal(isTerminalStatus('CANCELLED'), false);
    assert.equal(isTerminalStatus('bogus'), false);
  });

  it('describes the machine for the API', () => {
    const described = describeLifecycle();
    assert.deepEqual(described.states.map((s) => s.status), [...INVOICE_STATUSES]);
    assert.equal(described.states.find((s) => s.status === 'PAID')?.terminal, true);
    assert.equal(described.transitions.length, INVOICE_TRANSITIONS.length);
    assert.ok(described.transitions.every((t) => t.description.length > 0));
  });
});

interface Backend {
  name: string;
  storage: InvoiceStorage;
  /** Push a PENDING invoice past its expiry without running the sweep. */
  backdate(id: string): void;
}

function memoryBackend(): Backend {
  const raw = new MemoryStorage();
  return {
    name: 'in-memory storage',
    storage: new MemoryInvoiceStorage(new InvoiceMemoryService(raw)),
    backdate: (id) => {
      raw.updateInvoice(id, { expiresAt: new Date(Date.now() - 60_000) });
    },
  };
}

function postgresBackend(): Backend {
  const db = new FakeInvoiceDb();
  return {
    name: 'postgres storage double',
    storage: new PostgresInvoiceStorage(new InvoiceService(db)),
    backdate: (id) => db.backdateExpiry(id),
  };
}

const newInvoice = (storage: InvoiceStorage, amount = 10) =>
  storage.createInvoice({ amount, sellerPublicKey: SELLER, expiresInDays: 7 } as any);

const eventTypes = async (storage: InvoiceStorage, id: string) =>
  (await storage.getAuditTrail(id)).map((event) => event.eventType);

for (const make of [memoryBackend, postgresBackend]) {
  const { name } = make();

  describe(`invoice lifecycle enforced by ${name}`, () => {
    describe('allowed transitions', () => {
      it('PENDING -> PAID settles and is audited', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);

        const paid = await storage.markAsPaid(invoice.id, tx('a'), PAYER);

        assert.equal(paid.status, 'PAID');
        assert.deepEqual(await eventTypes(storage, invoice.id), ['INVOICE_CREATED', 'PAYMENT_CONFIRMED']);
      });

      it('PENDING -> CANCELLED cancels and records who and what changed', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);

        const cancelled = await storage.cancelInvoice(invoice.id, SELLER);

        assert.equal(cancelled.status, 'CANCELLED');
        const trail = await storage.getAuditTrail(invoice.id);
        assert.deepEqual(trail.map((e) => e.eventType), ['INVOICE_CREATED', 'INVOICE_CANCELLED']);
        assert.deepEqual(trail[1].eventData, { from: 'PENDING', to: 'CANCELLED', actor: SELLER });
      });

      it('PENDING -> EXPIRED expires past-due invoices and is audited once', async () => {
        const { storage, backdate } = make();
        const invoice = await newInvoice(storage);
        backdate(invoice.id);

        assert.equal(await storage.markExpiredInvoices(), 1);
        assert.equal(await storage.markExpiredInvoices(), 0, 'a second sweep must not re-expire');

        assert.equal((await storage.getInvoiceById(invoice.id))?.status, 'EXPIRED');
        const trail = await storage.getAuditTrail(invoice.id);
        assert.deepEqual(trail.map((e) => e.eventType), ['INVOICE_CREATED', 'INVOICE_EXPIRED']);
        assert.deepEqual(trail[1].eventData, { from: 'PENDING', to: 'EXPIRED' });
      });

      it('CANCELLED -> PAID records a payment that settled after the seller cancelled', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);
        await storage.cancelInvoice(invoice.id, SELLER);

        const paid = await storage.markAsPaid(invoice.id, tx('b'), PAYER, undefined, {
          settledAt: new Date(Date.now() + 1000),
        });

        assert.equal(paid.status, 'PAID');
        assert.equal(paid.settlementContext, 'AFTER_CANCEL');
        assert.deepEqual(await eventTypes(storage, invoice.id), [
          'INVOICE_CREATED',
          'INVOICE_CANCELLED',
          'PAYMENT_CONFIRMED',
        ]);
      });
    });

    describe('rejected transitions', () => {
      const rejected = (from: InvoiceStatus, to: InvoiceStatus) => (error: any) => {
        assert.ok(error instanceof InvalidTransitionError, `expected InvalidTransitionError, got ${error}`);
        assert.equal(error.code, 'INVALID_TRANSITION');
        assert.equal(error.from, from);
        assert.equal(error.to, to);
        return true;
      };

      it('PAID -> CANCELLED is refused and the invoice stays PAID', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);
        await storage.markAsPaid(invoice.id, tx('a'), PAYER);

        await assert.rejects(() => storage.cancelInvoice(invoice.id, SELLER), rejected('PAID', 'CANCELLED'));
        assert.equal((await storage.getInvoiceById(invoice.id))?.status, 'PAID');
      });

      it('CANCELLED -> CANCELLED is refused', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);
        await storage.cancelInvoice(invoice.id, SELLER);

        await assert.rejects(() => storage.cancelInvoice(invoice.id, SELLER), rejected('CANCELLED', 'CANCELLED'));
      });

      it('EXPIRED -> CANCELLED is refused', async () => {
        const { storage, backdate } = make();
        const invoice = await newInvoice(storage);
        backdate(invoice.id);

        await assert.rejects(() => storage.cancelInvoice(invoice.id, SELLER), rejected('EXPIRED', 'CANCELLED'));
      });

      it('PAID -> PAID is refused, so a replayed settlement cannot double-apply', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);
        await storage.markAsPaid(invoice.id, tx('a'), PAYER);

        await assert.rejects(() => storage.markAsPaid(invoice.id, tx('c'), PAYER), rejected('PAID', 'PAID'));
        assert.equal((await storage.getInvoiceById(invoice.id))?.paymentTxHash, tx('a'));
      });

      it('EXPIRED -> PAID is refused, including a payment that raced the expiry', async () => {
        const { storage, backdate } = make();
        const invoice = await newInvoice(storage);
        backdate(invoice.id);

        await assert.rejects(() => storage.markAsPaid(invoice.id, tx('d'), PAYER), rejected('EXPIRED', 'PAID'));
        assert.equal((await storage.getInvoiceById(invoice.id))?.status, 'EXPIRED');
      });

      it('a refused transition writes no audit event', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);
        await storage.markAsPaid(invoice.id, tx('a'), PAYER);
        await assert.rejects(() => storage.cancelInvoice(invoice.id, SELLER));

        assert.deepEqual(await eventTypes(storage, invoice.id), ['INVOICE_CREATED', 'PAYMENT_CONFIRMED']);
      });

      it('an unknown invoice is "not found", not an invalid transition', async () => {
        const { storage } = make();

        await assert.rejects(() => storage.cancelInvoice('missing-id', SELLER), /Invoice not found/);
        await assert.rejects(() => storage.markAsPaid('missing-id', tx('a'), PAYER), /Invoice not found/);
      });

      it('a non-owner is refused as unauthorized before the state is considered', async () => {
        const { storage } = make();
        const invoice = await newInvoice(storage);
        await storage.markAsPaid(invoice.id, tx('a'), PAYER);

        await assert.rejects(
          () => storage.cancelInvoice(invoice.id, OTHER_SELLER),
          /Unauthorized: only the seller can cancel this invoice/
        );
      });
    });
  });
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res as Response & { statusCode: number; body: any };
}

const fakeReq = (init: { body?: any; params?: any; query?: any } = {}) =>
  ({ body: init.body ?? {}, params: init.params ?? {}, query: init.query ?? {}, headers: {} }) as unknown as Request;

for (const make of [memoryBackend, postgresBackend]) {
  describe(`invoice lifecycle over HTTP handlers (${make().name})`, () => {
    it('rejects cancelling a paid invoice with 400 INVALID_TRANSITION and the from/to states', async () => {
      const { storage } = make();
      const handlers = createInvoiceHandlers({ storage });
      const invoice = await newInvoice(storage);
      await storage.markAsPaid(invoice.id, tx('a'), PAYER);

      const res = fakeRes();
      await handlers.cancelInvoice(
        fakeReq({ params: { id: invoice.id }, body: { sellerPublicKey: SELLER } }),
        res
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'INVALID_TRANSITION');
      assert.deepEqual(res.body.details, { from: 'PAID', to: 'CANCELLED' });
    });

    it('serves the same lifecycle model the stores enforce', async () => {
      const { storage } = make();
      const handlers = createInvoiceHandlers({ storage });

      const res = fakeRes();
      await handlers.getLifecycle(fakeReq(), res);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data, describeLifecycle());
    });
  });
}
