import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeEnvironment, simulationAllowed } from '../src/config/runtime';
import { MemoryStorage } from '../src/storage/memory-storage';
import { emailAntiSpamService } from '../src/services/email-anti-spam.service';
import { EmailQueueService } from '../src/services/email-queue.service';
import { MemoryEmailDeliveryStorage } from '../src/storage/memory-email-delivery-storage';
import { createInvoiceHandlers } from '../src/routes/invoice.handlers';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';

describe('Phase D: Issues #31, #33, #34 Tests', () => {
  describe('Issue #34: Harden ALLOW_SIMULATE Against Public Exposure', () => {
    it('refuses to boot if ALLOW_SIMULATE=true when NODE_ENV=production', () => {
      assert.throws(
        () => {
          assertSafeEnvironment({
            NODE_ENV: 'production',
            ALLOW_SIMULATE: 'true',
          });
        },
        /CRITICAL SECURITY CONFIGURATION ERROR/
      );
    });

    it('boots safely when ALLOW_SIMULATE is false or unset in production', () => {
      assert.doesNotThrow(() => {
        assertSafeEnvironment({
          NODE_ENV: 'production',
          ALLOW_SIMULATE: 'false',
        });
      });
      assert.doesNotThrow(() => {
        assertSafeEnvironment({
          NODE_ENV: 'production',
        });
      });
    });

    it('allows ALLOW_SIMULATE=true in development or test', () => {
      assert.doesNotThrow(() => {
        assertSafeEnvironment({
          NODE_ENV: 'development',
          ALLOW_SIMULATE: 'true',
        });
      });
      assert.equal(simulationAllowed({ NODE_ENV: 'development', ALLOW_SIMULATE: 'true' }), true);
      assert.equal(simulationAllowed({ NODE_ENV: 'production', ALLOW_SIMULATE: 'true' }), false);
    });
  });

  describe('Issue #33: Demo Data Retention & Stale Purging', () => {
    let storage: MemoryStorage;

    beforeEach(() => {
      storage = new MemoryStorage();
    });

    it('purges settled, expired, and cancelled invoices older than retention window while preserving in-flight pending invoices', () => {
      const now = Date.now();
      const thirtyHoursAgo = new Date(now - 30 * 3600 * 1000);
      const fiveHoursAgo = new Date(now - 5 * 3600 * 1000);
      const futureExpiry = new Date(now + 24 * 3600 * 1000);
      const pastExpiry = new Date(now - 2 * 3600 * 1000);

      const sellerKey = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IFBS7PR5ST4';

      // 1. Old PAID invoice (should be purged)
      const inv1 = storage.createInvoice({
        sellerPublicKey: sellerKey,
        amount: 10,
        memo: 'OLD_PAID_1',
      });
      inv1.createdAt = thirtyHoursAgo;
      inv1.status = 'PAID';

      // 2. Old CANCELLED invoice (should be purged)
      const inv2 = storage.createInvoice({
        sellerPublicKey: sellerKey,
        amount: 20,
        memo: 'OLD_CANCEL_2',
      });
      inv2.createdAt = thirtyHoursAgo;
      inv2.status = 'CANCELLED';

      // 3. Old EXPIRED invoice (should be purged)
      const inv3 = storage.createInvoice({
        sellerPublicKey: sellerKey,
        amount: 30,
        memo: 'OLD_EXPIRED_3',
      });
      inv3.createdAt = thirtyHoursAgo;
      inv3.status = 'EXPIRED';

      // 4. Old PENDING invoice but expired (should be purged)
      const inv4 = storage.createInvoice({
        sellerPublicKey: sellerKey,
        amount: 40,
        memo: 'OLD_PENDING_EXPIRED_4',
        expiresAt: pastExpiry,
      });
      inv4.createdAt = thirtyHoursAgo;

      // 5. Old PENDING invoice that is NOT expired (IN-FLIGHT ACTIVE SESSION - MUST BE PRESERVED!)
      const inv5 = storage.createInvoice({
        sellerPublicKey: sellerKey,
        amount: 50,
        memo: 'OLD_PENDING_ACTIVE_5',
        expiresAt: futureExpiry,
      });
      inv5.createdAt = thirtyHoursAgo;

      // 6. Recent PAID invoice (under 24h - MUST BE PRESERVED!)
      const inv6 = storage.createInvoice({
        sellerPublicKey: sellerKey,
        amount: 60,
        memo: 'RECENT_PAID_6',
      });
      inv6.createdAt = fiveHoursAgo;
      inv6.status = 'PAID';

      assert.equal(storage.size(), 6);

      const purged = storage.purgeStaleInvoices({ maxAgeHours: 24 });
      assert.equal(purged, 4); // inv1, inv2, inv3, inv4
      assert.equal(storage.size(), 2); // inv5 and inv6 remain

      // Verify inv5 and inv6 are still present
      assert.ok(storage.getInvoiceById(inv5.id));
      assert.ok(storage.getInvoiceById(inv6.id));
      // Verify inv1 is gone
      assert.equal(storage.getInvoiceById(inv1.id), undefined);
    });
  });

  describe('Issue #31: Abuse Prevention & Email Spam Controls', () => {
    beforeEach(() => {
      emailAntiSpamService.resetAll();
    });

    it('rejects disposable and temporary email domains in anti-spam validator', () => {
      const disposableCheck = emailAntiSpamService.validateRecipient('attacker@mailinator.com');
      assert.equal(disposableCheck.valid, false);
      assert.match(disposableCheck.error!, /Disposable and temporary/);

      const tempmailCheck = emailAntiSpamService.validateRecipient('spammer@tempmail.com');
      assert.equal(tempmailCheck.valid, false);

      const legitimateCheck = emailAntiSpamService.validateRecipient('customer@acme-corp.com');
      assert.equal(legitimateCheck.valid, true);
    });

    it('enforces recipient opt-out / blocklist', () => {
      const recipient = 'optout-user@example.com';
      assert.equal(emailAntiSpamService.validateRecipient(recipient).valid, true);

      emailAntiSpamService.blockEmail(recipient);
      const blockedResult = emailAntiSpamService.validateRecipient(recipient);
      assert.equal(blockedResult.valid, false);
      assert.match(blockedResult.error!, /blocked list/);
    });

    it('enforces max 3 emails per invoice in email queue service', async () => {
      const emailStorage = new MemoryEmailDeliveryStorage();
      const queue = new EmailQueueService({
        storage: emailStorage,
        antiSpam: emailAntiSpamService,
        maxEmailsPerInvoice: 3,
      });

      const invoiceId = 'inv-test-abuse-123';
      const senderWallet = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IFBS7PR5ST4';

      // First 3 emails succeed
      const res1 = await queue.enqueue({
        invoiceId,
        recipientEmail: 'client1@example.com',
        senderWallet,
        emailType: 'INVOICE_SENT',
        subject: 'Invoice 1',
      });
      assert.equal(res1.success, true);

      const res2 = await queue.enqueue({
        invoiceId,
        recipientEmail: 'client2@example.com',
        senderWallet,
        emailType: 'INVOICE_SENT',
        subject: 'Invoice 2',
      });
      assert.equal(res2.success, true);

      const res3 = await queue.enqueue({
        invoiceId,
        recipientEmail: 'client3@example.com',
        senderWallet,
        emailType: 'INVOICE_SENT',
        subject: 'Invoice 3',
      });
      assert.equal(res3.success, true);

      // 4th email must be rejected with EXCEEDED_INVOICE_EMAIL_LIMIT
      const res4 = await queue.enqueue({
        invoiceId,
        recipientEmail: 'client4@example.com',
        senderWallet,
        emailType: 'INVOICE_SENT',
        subject: 'Invoice 4',
      });
      assert.equal(res4.success, false);
      assert.equal(res4.code, 'EXCEEDED_INVOICE_EMAIL_LIMIT');
    });

    it('createInvoice rejects disposable customer email addresses', async () => {
      const memStorage = new MemoryInvoiceStorage();
      const handlers = createInvoiceHandlers({ storage: memStorage });

      let statusCode = 0;
      let responseBody: any = null;
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: any) {
          responseBody = body;
          return this;
        },
      };

      const req: any = {
        body: {
          sellerPublicKey: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IFBS7PR5ST4',
          amount: 50,
          assetCode: 'XLM',
          memo: 'TEST_DISPOSABLE',
          customerEmail: 'spam@mailinator.com',
        },
      };

      await handlers.createInvoice(req, res);
      assert.equal(statusCode, 400);
      assert.equal(responseBody.code, 'DISPOSABLE_EMAIL_REJECTED');
    });

    it('enforces maximum pending invoices per wallet limit', async () => {
      const memStorage = new MemoryInvoiceStorage();
      const handlers = createInvoiceHandlers({ storage: memStorage });
      const sellerKey = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IFBS7PR5ST4';

      // Set max pending to 2 for this test
      const prevEnv = process.env.MAX_PENDING_INVOICES_PER_SELLER;
      process.env.MAX_PENDING_INVOICES_PER_SELLER = '2';

      try {
        const createReq = (memo: string) => ({
          body: {
            sellerPublicKey: sellerKey,
            amount: 10,
            assetCode: 'XLM',
            memo,
          },
        });

        const makeCall = async (req: any) => {
          let statusCode = 0;
          let responseBody: any = null;
          const res: any = {
            status(code: number) {
              statusCode = code;
              return this;
            },
            json(body: any) {
              responseBody = body;
              return this;
            },
          };
          await handlers.createInvoice(req, res);
          return { statusCode, responseBody };
        };

        const res1 = await makeCall(createReq('PENDING_1'));
        assert.equal(res1.statusCode, 201);

        const res2 = await makeCall(createReq('PENDING_2'));
        assert.equal(res2.statusCode, 201);

        // 3rd pending invoice exceeds limit of 2
        const res3 = await makeCall(createReq('PENDING_3'));
        assert.equal(res3.statusCode, 429);
        assert.equal(res3.responseBody.code, 'PENDING_INVOICE_LIMIT_EXCEEDED');
      } finally {
        process.env.MAX_PENDING_INVOICES_PER_SELLER = prevEnv;
      }
    });
  });
});
