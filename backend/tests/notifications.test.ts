import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import {
  MemoryNotificationStore,
  NotificationService,
  RECOVERABLE_REJECTIONS,
} from '../src/notifications/notification-service.ts';
import { createNotificationRouter } from '../src/routes/notification.routes.ts';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';
import type { StoredInvoice } from '../src/storage/invoice-storage.ts';

const SELLER_A = 'G' + 'A'.repeat(55);
const SELLER_B = 'G' + 'B'.repeat(55);
const PAYER = 'G' + 'C'.repeat(55);
const TX = 'a'.repeat(64);

const invoice = (over: Partial<StoredInvoice> = {}): StoredInvoice => ({
  id: 'inv-1',
  sellerPublicKey: SELLER_A,
  amount: 10,
  assetCode: 'XLM',
  memo: 'INV-1',
  status: 'PENDING',
  customerName: 'Secret Customer',
  customerEmail: 'secret@customer.example',
  payerName: 'Secret Payer',
  payerEmail: 'secret@payer.example',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 1000),
  ...over,
});

describe('Notification system (Issue #56)', () => {
  let clock: Date;
  let service: NotificationService;

  beforeEach(() => {
    clock = new Date('2026-01-01T00:00:00.000Z');
    service = new NotificationService(new MemoryNotificationStore(), () => clock);
  });

  describe('targeting', () => {
    it('emits paid / expired / cancelled notifications to the seller only, with a workflow deep link', () => {
      const paid = service.syncInvoiceNotifications(invoice({ id: 'p', status: 'PAID' }));
      const expired = service.syncInvoiceNotifications(invoice({ id: 'e', status: 'EXPIRED' }));
      const cancelled = service.syncInvoiceNotifications(invoice({ id: 'c', status: 'CANCELLED' }));

      assert.deepEqual([paid?.type, expired?.type, cancelled?.type], ['invoice.paid', 'invoice.expired', 'invoice.cancelled']);
      assert.deepEqual([paid?.severity, expired?.severity, cancelled?.severity], ['success', 'warning', 'info']);
      assert.equal(paid?.deepLink, '/invoice/p');
      assert.equal(paid?.recipient, SELLER_A);
      assert.equal(service.list(SELLER_A).total, 3);
      assert.equal(service.list(SELLER_B).total, 0);
    });

    it('does not notify for PENDING invoices', () => {
      assert.equal(service.syncInvoiceNotifications(invoice()), null);
      assert.equal(service.list(SELLER_A).total, 0);
    });

    it('url-encodes the entity id in deep links', () => {
      const n = service.syncInvoiceNotifications(invoice({ id: 'a/b?c', status: 'PAID' }));
      assert.equal(n?.deepLink, '/invoice/a%2Fb%3Fc');
    });
  });

  describe('deduplication', () => {
    it('notifies once no matter how many times the same state is synced (retries)', () => {
      const first = service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
      clock = new Date(clock.getTime() + 5000);
      const again = service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
      service.syncInvoiceNotifications(invoice({ status: 'PAID' }));

      assert.equal(again?.id, first?.id);
      assert.equal(again?.createdAt, first?.createdAt);
      assert.equal(service.list(SELLER_A).total, 1);
    });

    it('treats different events for the same invoice as distinct', () => {
      service.syncInvoiceNotifications(invoice({ status: 'EXPIRED' }));
      service.syncInvoiceNotifications(invoice({ status: 'CANCELLED' }));
      assert.equal(service.list(SELLER_A).total, 2);
    });

    it('dedupes payment rejections per transaction and code, but not across them', () => {
      const inv = invoice();
      const a = service.notifyPaymentRejected(inv, 'AMOUNT_MISMATCH', TX);
      const b = service.notifyPaymentRejected(inv, 'AMOUNT_MISMATCH', TX);
      service.notifyPaymentRejected(inv, 'AMOUNT_MISMATCH', 'b'.repeat(64));
      service.notifyPaymentRejected(inv, 'ASSET_MISMATCH', TX);
      assert.equal(a?.id, b?.id);
      assert.equal(service.list(SELLER_A).total, 3);
    });
  });

  describe('recovery notifications', () => {
    it('gives the seller actionable advice for every recoverable rejection', () => {
      for (const code of RECOVERABLE_REJECTIONS) {
        const n = service.notifyPaymentRejected(invoice({ id: `i-${code}` }), code, TX);
        assert.equal(n?.severity, 'critical');
        assert.equal(n?.type, 'payment.rejected');
        assert.ok(n && n.message.length > 20, code);
        assert.equal(n?.data.code, code);
      }
    });

    it('ignores rejections the seller cannot act on', () => {
      for (const code of ['INVALID_TX_HASH', 'INVOICE_EXPIRED', 'TRANSACTION_NOT_FOUND', 'INVALID_PAYER_EMAIL'] as const) {
        assert.equal(service.notifyPaymentRejected(invoice(), code, TX), null);
      }
      assert.equal(service.list(SELLER_A).total, 0);
    });
  });

  describe('privacy', () => {
    it('never copies customer or payer personal data into a notification', () => {
      service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
      service.notifyPaymentRejected(invoice({ id: 'r' }), 'AMOUNT_MISMATCH', TX);
      const dump = JSON.stringify(service.list(SELLER_A).notifications);
      for (const secret of ['Secret Customer', 'secret@customer.example', 'Secret Payer', 'secret@payer.example']) {
        assert.equal(dump.includes(secret), false, `${secret} leaked`);
      }
    });

    it('does not let another recipient read or mark a notification, and does not reveal it exists', () => {
      const n = service.syncInvoiceNotifications(invoice({ status: 'PAID' }))!;
      assert.equal(service.markRead(SELLER_B, n.id), null);
      assert.equal(service.markRead(SELLER_B, 'no-such-id'), null);
      assert.equal(service.list(SELLER_A).unread, 1, 'foreign attempt must not mark read');
      assert.equal(service.list(SELLER_B).total, 0);
      assert.equal(service.markAllRead(SELLER_B), 0);
      assert.equal(service.unreadCount(SELLER_B), 0);
    });
  });

  describe('read state', () => {
    it('tracks unread, marks read once, and supports mark-all', () => {
      const a = service.syncInvoiceNotifications(invoice({ id: 'a', status: 'PAID' }))!;
      service.syncInvoiceNotifications(invoice({ id: 'b', status: 'EXPIRED' }));
      service.syncInvoiceNotifications(invoice({ id: 'c', status: 'CANCELLED' }));
      assert.equal(service.unreadCount(SELLER_A), 3);

      clock = new Date('2026-01-02T00:00:00.000Z');
      const read = service.markRead(SELLER_A, a.id);
      assert.equal(read?.readAt, '2026-01-02T00:00:00.000Z');
      clock = new Date('2026-01-03T00:00:00.000Z');
      assert.equal(service.markRead(SELLER_A, a.id)?.readAt, '2026-01-02T00:00:00.000Z', 'idempotent');
      assert.equal(service.unreadCount(SELLER_A), 2);

      assert.equal(service.list(SELLER_A, { unreadOnly: true }).total, 2);
      assert.equal(service.markAllRead(SELLER_A), 2);
      assert.equal(service.markAllRead(SELLER_A), 0);
      assert.equal(service.list(SELLER_A, { unreadOnly: true }).total, 0);
      assert.equal(service.list(SELLER_A).total, 3);
    });

    it('lists newest first with bounded pagination', () => {
      for (let i = 0; i < 5; i++) service.syncInvoiceNotifications(invoice({ id: `n${i}`, status: 'PAID' }));
      const page = service.list(SELLER_A, { limit: 2, offset: 1 });
      assert.deepEqual(page.notifications.map((n) => n.entityId), ['n3', 'n2']);
      assert.equal(page.total, 5);
      assert.equal(service.list(SELLER_A, { limit: 0 }).limit, 1);
      assert.equal(service.list(SELLER_A, { limit: 9999 }).limit, 100);
      assert.equal(service.list(SELLER_A, { offset: -3 }).offset, 0);
    });

    it('clear() empties the service, and the default constructor works', () => {
      service.syncInvoiceNotifications(invoice({ status: 'PAID' }));
      service.clear();
      assert.equal(service.list(SELLER_A).total, 0);
      const fresh = new NotificationService();
      assert.ok(fresh.syncInvoiceNotifications(invoice({ status: 'PAID' }))?.createdAt);
    });
  });

  describe('integration with invoice handlers', () => {
    let storage: MemoryInvoiceStorage;
    let tx: any;

    const res = () => {
      const r: any = { statusCode: 200, body: undefined, status(c: number) { r.statusCode = c; return r; }, json(p: any) { r.body = p; return r; } };
      return r as Response & { statusCode: number; body: any };
    };
    const handlers = (extra: Record<string, unknown> = {}) =>
      createInvoiceHandlers({
        storage,
        frontendUrl: 'http://localhost:3000',
        allowSimulate: true,
        notifications: service,
        stellar: { getTransaction: async () => tx },
        ...extra,
      });
    const run = async (fn: (q: Request, r: Response) => Promise<void>, init: { body?: any; params?: any; query?: any }) => {
      const r = res();
      await fn({ body: init.body ?? {}, params: init.params ?? {}, query: init.query ?? {} } as Request, r);
      return r;
    };
    const create = async (over: Record<string, unknown> = {}) => {
      const r = await run(handlers().createInvoice, { body: { amount: 42.5, assetCode: 'XLM', sellerPublicKey: SELLER_A, customerEmail: 'cust@example.com', ...over } });
      assert.equal(r.statusCode, 201);
      return r.body.data.invoice as StoredInvoice;
    };

    beforeEach(() => {
      memoryStorage.clear();
      storage = new MemoryInvoiceStorage();
    });

    it('creating an invoice does not notify', async () => {
      await create();
      assert.equal(service.list(SELLER_A).total, 0);
    });

    it('notifies once on verified payment, even if the client retries the verify call', async () => {
      const inv = await create();
      tx = { transaction: { memo: inv.memo }, operations: [{ type: 'payment', from: PAYER, to: SELLER_A, amount: '42.5000000', asset_type: 'native' }] };

      const ok = await run(handlers().verifyPayment, { params: { id: inv.id }, body: { txHash: TX, payerEmail: 'payer@example.com' } });
      assert.equal(ok.statusCode, 200);
      const retry = await run(handlers().verifyPayment, { params: { id: inv.id }, body: { txHash: TX } });
      assert.equal(retry.statusCode, 400, 'already paid');
      await run(handlers().getInvoice, { params: { id: inv.id } });
      await run(handlers().getInvoices, { query: { sellerPublicKey: SELLER_A } });

      const { notifications } = service.list(SELLER_A);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, 'invoice.paid');
      assert.equal(notifications[0].deepLink, `/invoice/${inv.id}`);
      const dump = JSON.stringify(notifications);
      assert.equal(dump.includes('cust@example.com') || dump.includes('payer@example.com'), false);
      assert.equal(service.list(SELLER_B).total, 0);
    });

    it('notifies on simulated payment and on cancellation', async () => {
      const a = await create();
      const b = await create();
      assert.equal((await run(handlers().simulatePayment, { params: { id: a.id } })).statusCode, 200);
      assert.equal((await run(handlers().cancelInvoice, { params: { id: b.id } })).statusCode, 200);
      assert.deepEqual(service.list(SELLER_A).notifications.map((n) => n.type).sort(), ['invoice.cancelled', 'invoice.paid']);
    });

    it('notifies the seller once when a pending invoice expires (observed on read)', async () => {
      const inv = await create({ expiresInDays: 1 });
      await storage.markExpiredInvoices(new Date(Date.now() + 2 * 86_400_000));
      await run(handlers().getInvoice, { params: { id: inv.id } });
      await run(handlers().getInvoice, { params: { id: inv.id } });
      const { notifications } = service.list(SELLER_A);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, 'invoice.expired');
    });

    it('sends a recovery notification for a wrong-amount payment, once per transaction', async () => {
      const inv = await create();
      tx = { transaction: { memo: inv.memo }, operations: [{ type: 'payment', from: PAYER, to: SELLER_A, amount: '1.0000000', asset_type: 'native' }] };
      for (let i = 0; i < 3; i++) {
        const r = await run(handlers().verifyPayment, { params: { id: inv.id }, body: { txHash: TX } });
        assert.equal(r.statusCode, 400);
      }
      const { notifications } = service.list(SELLER_A);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, 'payment.rejected');
      assert.equal(notifications[0].data.code, 'AMOUNT_MISMATCH');
    });

    it('does not fail the request when notification delivery throws', async () => {
      const inv = await create();
      const broken = { syncInvoiceNotifications: () => { throw new Error('boom'); }, notifyPaymentRejected: () => { throw new Error('boom'); } } as any;
      const original = console.error;
      console.error = () => {};
      try {
        const r = await run(handlers({ notifications: broken }).getInvoice, { params: { id: inv.id } });
        assert.equal(r.statusCode, 200);
        tx = { transaction: { memo: inv.memo }, operations: [{ type: 'payment', from: PAYER, to: SELLER_A, amount: '1.0000000', asset_type: 'native' }] };
        const v = await run(handlers({ notifications: broken }).verifyPayment, { params: { id: inv.id }, body: { txHash: TX } });
        assert.equal(v.statusCode, 400);
        assert.equal(v.body.code, 'AMOUNT_MISMATCH');
      } finally {
        console.error = original;
      }
    });
  });

  describe('notification routes', () => {
    async function withServer(fn: (call: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>) => Promise<void>, svc: NotificationService = service) {
      const app = express();
      app.use(express.json());
      app.use('/api', createNotificationRouter({ service: svc }));
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      const call = async (path: string, init: RequestInit = {}) => {
        const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
        return { status: r.status, body: await r.json() };
      };
      try {
        await fn(call);
      } finally {
        server.close();
      }
    }
    const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

    it('requires a valid recipient on every route', async () => {
      await withServer(async (call) => {
        for (const [path, init] of [['/notifications', undefined], ['/notifications?recipient=nope', undefined], ['/notifications/unread-count', undefined], ['/notifications/read-all', post({})], ['/notifications/x/read', post({ recipient: 'bad' })]] as const) {
          const r = await call(path, init);
          assert.equal(r.status, 400, path);
          assert.equal(r.body.code, 'RECIPIENT_REQUIRED');
        }
      });
    });

    it('lists, counts, marks read and marks all read for the recipient only', async () => {
      const n = service.syncInvoiceNotifications(invoice({ id: 'a', status: 'PAID' }))!;
      service.syncInvoiceNotifications(invoice({ id: 'b', status: 'EXPIRED' }));
      service.syncInvoiceNotifications(invoice({ id: 'z', sellerPublicKey: SELLER_B, status: 'PAID' }));

      await withServer(async (call) => {
        const list = await call(`/notifications?recipient=${SELLER_A}&limit=1&offset=abc`);
        assert.equal(list.status, 200);
        assert.equal(list.body.data.notifications.length, 1);
        assert.equal(list.body.data.unread, 2);
        assert.equal(list.body.pagination.total, 2);

        assert.equal((await call(`/notifications/unread-count?recipient=${SELLER_A}`)).body.data.unread, 2);

        const foreign = await call(`/notifications/${n.id}/read`, post({ recipient: SELLER_B }));
        assert.equal(foreign.status, 404);
        assert.equal(foreign.body.code, 'NOTIFICATION_NOT_FOUND');

        const read = await call(`/notifications/${n.id}/read`, post({ recipient: SELLER_A }));
        assert.equal(read.status, 200);
        assert.ok(read.body.data.readAt);
        assert.equal((await call(`/notifications?recipient=${SELLER_A}&unread=true`)).body.data.notifications.length, 1);

        assert.equal((await call('/notifications/read-all', post({ recipient: SELLER_A }))).body.data.updated, 1);
        assert.equal((await call(`/notifications/unread-count?recipient=${SELLER_B}`)).body.data.unread, 1);
      });
    });

    it('uses the shared service by default', async () => {
      const app = express();
      app.use('/api', createNotificationRouter());
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/notifications/unread-count?recipient=${SELLER_A}`);
        assert.equal(r.status, 200);
      } finally {
        server.close();
      }
    });
  });
});
