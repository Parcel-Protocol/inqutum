import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';
import { ImportService, parseCsv, ImportFormatError } from '../src/imports/import-service.ts';
import { csvCell } from '../src/exports/export-service.ts';

const SELLER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ISSUER = 'GAMVMPAABPFYKAXOGUT3FO5TRO4ILT6VYUNAYVGPAYGVGT5TO46R2ZZK';

function row(overrides: Record<string, unknown> = {}) {
  return { sellerPublicKey: SELLER, amount: 25, externalId: 'INV-1', ...overrides };
}

describe('import pipeline (issue #53)', () => {
  let store: MemoryStorage;
  let storage: MemoryInvoiceStorage;
  let service: ImportService;

  /** Every stored invoice, via the public seller-scoped read. */
  const all = () => storage.getInvoicesBySeller(SELLER, undefined, 1000);

  beforeEach(() => {
    store = new MemoryStorage();
    storage = new MemoryInvoiceStorage(new InvoiceMemoryService(store));
    service = new ImportService(storage);
  });

  /* ---------------------------------------------------------------- */
  /* Dry run performs no persistent writes                             */
  /* ---------------------------------------------------------------- */

  describe('dry run', () => {
    it('reports the plan without creating anything', async () => {
      const plan = await service.plan('json', [row(), row({ externalId: 'INV-2', amount: 30 })]);

      assert.equal(plan.dryRun, true);
      assert.deepEqual(plan.counts, { create: 2, update: 0, skip: 0, error: 0 });
      assert.equal(plan.total, 2);
      assert.equal(store.size(), 0, 'dry run must not write');
    });

    it('is the default when the caller does not pass dryRun', async () => {
      const plan = await service.run({ payload: [row()] });

      assert.equal(plan.dryRun, true);
      assert.equal(store.size(), 0);
    });

    it('requires an explicit dryRun:false to write', async () => {
      const plan = await service.run({ payload: [row()], dryRun: false });

      assert.equal(plan.dryRun, false);
      assert.equal(plan.counts.create, 1);
      assert.equal(store.size(), 1);
    });

    it('does not mutate invoices it previews, even for rows it would update', async () => {
      await service.run({ payload: [row({ description: 'first' })], dryRun: false });
      const [before] = await all();

      const plan = await service.plan('json', [row({ description: 'second' })]);

      assert.equal(plan.counts.update, 1);
      const [after] = await all();
      assert.equal(after.description, before.description, 'dry run must not apply the update');
    });
  });

  /* ---------------------------------------------------------------- */
  /* Invalid rows                                                      */
  /* ---------------------------------------------------------------- */

  describe('invalid rows', () => {
    it('rejects a bad seller key and names the field and row', async () => {
      const plan = await service.plan('json', [row(), row({ externalId: 'INV-2', sellerPublicKey: 'NOT-A-KEY' })]);

      assert.equal(plan.counts.error, 1);
      assert.equal(plan.counts.create, 1);
      const failed = plan.rows.find((r) => r.action === 'error')!;
      assert.equal(failed.row, 2);
      assert.match(failed.reason!, /sellerPublicKey/);
    });

    it('rejects a non-positive amount', async () => {
      const plan = await service.plan('json', [row({ amount: 0 })]);
      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /amount/);
    });

    it('rejects an issued asset with no issuer, exactly as the create endpoint does', async () => {
      const plan = await service.plan('json', [row({ assetCode: 'USDC' })]);
      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /assetIssuer/);
    });

    it('accepts an issued asset once the issuer is supplied', async () => {
      const plan = await service.plan('json', [row({ assetCode: 'USDC', assetIssuer: ISSUER })]);
      assert.equal(plan.counts.error, 0);
      assert.equal(plan.counts.create, 1);
    });

    it('rejects an out-of-range expiry window', async () => {
      const plan = await service.plan('json', [row({ expiresInDays: 365 })]);
      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /expiresInDays/);
    });

    it('rejects an externalId with control characters', async () => {
      const plan = await service.plan('json', [row({ externalId: 'INV-1' })]);
      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /externalId/);
    });

    it('rejects an externalId longer than the column', async () => {
      const plan = await service.plan('json', [row({ externalId: 'x'.repeat(256) })]);
      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /externalId/);
    });

    it('keeps valid rows in the plan when a sibling row is invalid', async () => {
      const plan = await service.plan('json', [
        row({ externalId: 'OK-1' }),
        row({ externalId: 'BAD', amount: -5 }),
        row({ externalId: 'OK-2' }),
      ]);

      assert.deepEqual(plan.counts, { create: 2, update: 0, skip: 0, error: 1 });
    });

    it('explains an export payload instead of failing with field errors', async () => {
      await assert.rejects(
        () => service.run({ payload: [{ id: 'abc', memo: 'm', status: 'PENDING', amount: 5 }] }),
        (error: Error) => {
          assert.ok(error instanceof ImportFormatError);
          assert.match(error.message, /read-only projection/);
          return true;
        }
      );
    });

    it('refuses an empty row list and a non-array payload', async () => {
      await assert.rejects(() => service.run({ payload: [] }), ImportFormatError);
      await assert.rejects(() => service.run({ payload: 42 }), ImportFormatError);
      await assert.rejects(() => service.run({ payload: { nope: true } }), ImportFormatError);
    });

    it('enforces the row limit', async () => {
      const small = new ImportService(storage, { maxRows: 2 });
      await assert.rejects(
        () => small.plan('json', [row({ externalId: 'a' }), row({ externalId: 'b' }), row({ externalId: 'c' })]),
        /exceeds the limit of 2/
      );
    });

    it('honours a per-call maxRows passed through run()', async () => {
      const three = [row({ externalId: 'a' }), row({ externalId: 'b' }), row({ externalId: 'c' })];
      await assert.rejects(
        () => service.run({ payload: three, maxRows: 2 }),
        /exceeds the limit of 2/
      );
      // The same payload is fine when the caller raises its own cap.
      const plan = await service.run({ payload: three, maxRows: 5 });
      assert.equal(plan.total, 3);
    });

    it('never lets a per-call maxRows raise the deployment ceiling', async () => {
      const capped = new ImportService(storage, { maxRows: 2 });
      await assert.rejects(
        () => capped.run({ payload: [row({ externalId: 'a' }), row({ externalId: 'b' }), row({ externalId: 'c' })], maxRows: 100 }),
        /exceeds the limit of 2/
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /* Duplicates and idempotency                                        */
  /* ---------------------------------------------------------------- */

  describe('duplicates and idempotency', () => {
    it('is idempotent when the same file is imported twice', async () => {
      const rows = [row({ externalId: 'A' }), row({ externalId: 'B', amount: 40 })];

      const first = await service.run({ payload: rows, dryRun: false });
      assert.deepEqual(first.counts, { create: 2, update: 0, skip: 0, error: 0 });

      const second = await service.run({ payload: rows, dryRun: false });
      assert.deepEqual(second.counts, { create: 0, update: 0, skip: 2, error: 0 });
      assert.equal(store.size(), 2, 're-import must not duplicate invoices');
    });

    it('re-importing three times is still two invoices', async () => {
      const rows = [row({ externalId: 'A' }), row({ externalId: 'B', amount: 40 })];

      await service.run({ payload: rows, dryRun: false });
      await service.run({ payload: rows, dryRun: false });
      await service.run({ payload: rows, dryRun: false });

      assert.equal(store.size(), 2);
    });

    it('rejects a repeated externalId inside one file and names both rows', async () => {
      const plan = await service.plan('json', [
        row({ externalId: 'DUP', amount: 10 }),
        row({ externalId: 'DUP', amount: 99 }),
      ]);

      assert.deepEqual(plan.counts, { create: 1, update: 0, skip: 0, error: 1 });
      assert.deepEqual(plan.duplicateExternalIds, ['DUP']);
      const failed = plan.rows.find((r) => r.action === 'error')!;
      assert.equal(failed.row, 2);
      assert.match(failed.reason!, /row 1/);
    });

    it('rejects a row with no externalId on a second run, since it has no identity', async () => {
      await service.run({ payload: [row({ externalId: undefined })], dryRun: false });

      const second = await service.plan('json', [row({ externalId: undefined })]);
      assert.equal(second.counts.create, 1, 'a keyless row always plans a create');
      assert.match(second.rows[0].reason!, /cannot be matched/);
    });

    it('treats externalId as case-sensitive, matching the unique index', async () => {
      await service.run({ payload: [row({ externalId: 'INV-1' })], dryRun: false });
      const plan = await service.plan('json', [row({ externalId: 'inv-1' })]);

      assert.equal(plan.counts.create, 1);
    });

    it('skips a row whose descriptive fields already match', async () => {
      await service.run({ payload: [row({ description: 'same' })], dryRun: false });

      const plan = await service.plan('json', [row({ description: 'same' })]);
      assert.equal(plan.counts.skip, 1);
    });

    it('updates only the descriptive fields when they drift', async () => {
      const first = await service.run({ payload: [row({ description: 'first' })], dryRun: false });
      const invoiceId = first.rows[0].invoiceId!;

      const second = await service.run({
        payload: [row({ description: 'second', customerName: 'New Customer' })],
        dryRun: false,
      });

      assert.equal(second.counts.update, 1);
      const updated = (await storage.getInvoiceById(invoiceId))!;
      assert.equal(updated.description, 'second');
      assert.equal(updated.customerName, 'New Customer');
    });

    it('refuses to change the amount of an already-imported invoice', async () => {
      const first = await service.run({ payload: [row({ amount: 10 })], dryRun: false });
      const invoiceId = first.rows[0].invoiceId!;

      const plan = await service.plan('json', [row({ amount: 999 })]);

      assert.equal(plan.counts.error, 1);
      const failed = plan.rows.find((r) => r.action === 'error')!;
      assert.equal(failed.invoiceId, invoiceId);
      assert.match(failed.reason!, /cannot be changed by an import/);
      assert.equal((await storage.getInvoiceById(invoiceId))!.amount, 10, 'amount must be untouched');
    });

    it('refuses to reassign an invoice to a different seller', async () => {
      await service.run({ payload: [row()], dryRun: false });
      const other = 'GAMVMPAABPFYKAXOGUT3FO5TRO4ILT6VYUNAYVGPAYGVGT5TO46R2ZZK';

      const plan = await service.plan('json', [row({ sellerPublicKey: other })]);

      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /sellerPublicKey/);
    });

    it('leaves an immutable field alone when the row restates the same value', async () => {
      const first = await service.run({ payload: [row({ amount: 77, description: 'first' })], dryRun: false });

      // The row restates amount/seller exactly as stored and only changes the
      // description, so the plan is an update that must not touch the amount.
      const plan = await service.plan('json', [row({ amount: 77, description: 'new text' })]);

      assert.equal(plan.counts.update, 1);
      assert.equal(plan.counts.error, 0);
      assert.equal((await storage.getInvoiceById(first.rows[0].invoiceId!))!.amount, 77);
    });

    it('rejects a row that omits the required seller key', async () => {
      await service.run({ payload: [row()], dryRun: false });

      const plan = await service.plan('json', [{ externalId: 'INV-1', description: 'new text' }]);
      assert.equal(plan.counts.error, 1);
      assert.match(plan.rows[0].reason!, /sellerPublicKey/);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Partial failure                                                   */
  /* ---------------------------------------------------------------- */

  describe('partial failure', () => {
    it('keeps importing after a row throws, and reports the failure', async () => {
      let calls = 0;
      const flaky = {
        createInvoice: async (input: any) => {
          calls += 1;
          if (input.externalId === 'BOOM') throw new Error('storage unavailable');
          return {
            id: `id-${calls}`,
            sellerPublicKey: input.sellerPublicKey,
            amount: input.amount,
            assetCode: input.assetCode || 'XLM',
            memo: 'memo',
            status: 'PENDING',
            createdAt: new Date(),
            expiresAt: new Date(),
            externalId: input.externalId,
          };
        },
        getInvoiceByExternalId: async () => null,
        updateInvoiceMutableFields: async () => null,
      } as any;

      const partial = new ImportService(flaky);
      const result = await partial.run({
        payload: [row({ externalId: 'A' }), row({ externalId: 'BOOM' }), row({ externalId: 'C' })],
        dryRun: false,
      });

      assert.deepEqual(result.counts, { create: 2, update: 0, skip: 0, error: 1 });
      const failed = result.rows.find((r) => r.action === 'error')!;
      assert.equal(failed.row, 2);
      assert.match(failed.reason!, /storage unavailable/);
    });

    it('lists only the invoices it actually created in the rollback', async () => {
      const result = await service.run({
        payload: [row({ externalId: 'A' }), row({ externalId: 'B', sellerPublicKey: 'bad' })],
        dryRun: false,
      });

      assert.equal(result.counts.create, 1);
      assert.equal(result.rollback!.strategy, 'cancel-created');
      assert.equal(result.rollback!.invoiceIds.length, 1);
      assert.equal(result.rollback!.invoiceIds[0], result.rows[0].invoiceId);
      assert.match(result.rollback!.note, /PENDING/);
    });

    it('reports that there is nothing to roll back when nothing was written', async () => {
      const result = await service.run({ payload: [row({ sellerPublicKey: 'bad' })], dryRun: false });

      assert.equal(result.counts.create, 0);
      assert.deepEqual(result.rollback!.invoiceIds, []);
      assert.match(result.rollback!.note, /nothing to roll back/);
    });

    it('says a vanished invoice was not updated instead of claiming success', async () => {
      const first = await service.run({ payload: [row()], dryRun: false });
      const invoiceId = first.rows[0].invoiceId!;

      // Simulate the row disappearing between plan and apply by wrapping the
      // real storage so the update target resolves to nothing.
      const vanishing = new ImportService({
        ...storage,
        getInvoiceByExternalId: async (externalId: string) => {
          const found = await storage.getInvoiceByExternalId(externalId);
          return found ? { ...found, id: invoiceId } : null;
        },
        updateInvoiceMutableFields: async () => null,
      } as any);

      const result = await vanishing.run({ payload: [row({ description: 'changed' })], dryRun: false });

      assert.equal(result.counts.error, 1);
      assert.match(result.rows[0].reason!, /no longer exists/);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Remediation guidance                                              */
  /* ---------------------------------------------------------------- */

  describe('remediation', () => {
    it('tells the caller a failed row will be skipped on retry', async () => {
      const plan = await service.plan('json', [row(), row({ externalId: 'BAD', amount: -1 })]);

      const guidance = plan.remediation.join(' ');
      assert.match(guidance, /idempotent/);
      assert.match(guidance, /re-upload/);
      assert.match(guidance, /row 2/);
    });

    it('calls out duplicated externalIds by value', async () => {
      const plan = await service.plan('json', [row({ externalId: 'Z1' }), row({ externalId: 'Z1' })]);

      assert.match(plan.remediation[0], /Z1/);
    });

    it('carries no failure guidance for a clean plan', async () => {
      const plan = await service.plan('json', [row()]);

      assert.equal(plan.counts.error, 0);
      // A clean plan still notes that a re-run is safe; it must not claim any
      // row failed or was duplicated.
      assert.doesNotMatch(plan.remediation.join(' '), /failed|duplicat/i);
    });
  });

  /* ---------------------------------------------------------------- */
  /* CSV                                                               */
  /* ---------------------------------------------------------------- */

  describe('csv', () => {
    it('parses a header row and coerces numeric fields', () => {
      const rows = parseCsv(
        ['externalId,sellerPublicKey,amount,expiresInDays', `A,${SELLER},12.5,14`].join('\n')
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].externalId, 'A');
      assert.equal(rows[0].amount, 12.5);
      assert.equal(rows[0].expiresInDays, 14);
    });

    it('reads empty cells as absent so the schema default applies', () => {
      const rows = parseCsv([`externalId,sellerPublicKey,amount,assetCode`, `A,${SELLER},5,`].join('\n'));
      assert.equal(rows[0].assetCode, undefined);
    });

    it('handles quoted fields containing commas and escaped quotes', () => {
      const csv = [
        'externalId,sellerPublicKey,amount,description',
        `A,${SELLER},5,"Line one, line two"`,
        `B,${SELLER},6,"He said ""hi"""`,
      ].join('\n');

      const rows = parseCsv(csv);
      assert.equal(rows[0].description, 'Line one, line two');
      assert.equal(rows[1].description, 'He said "hi"');
    });

    it('handles CRLF line endings', () => {
      const rows = parseCsv(`externalId,sellerPublicKey,amount\r\nA,${SELLER},5\r\n`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].amount, 5);
    });

    it('round-trips values written by the export csv writer', async () => {
      const description = 'Contains, a comma and "quotes"';
      const csv = [
        'externalId,sellerPublicKey,amount,description',
        ['A', SELLER, '5', csvCell(description)].join(','),
      ].join('\n');

      const plan = await service.plan('csv', parseCsv(csv));
      assert.equal(plan.counts.create, 1);
      assert.equal((plan as any).rows[0].action, 'create');
    });

    it('rejects unknown columns with the supported list', () => {
      assert.throws(() => parseCsv(`nope,sellerPublicKey\nx,${SELLER}`), /Unsupported CSV column\(s\): nope/);
    });

    it('rejects an empty csv payload', () => {
      assert.throws(() => parseCsv(''), /empty/);
    });

    it('validates csv rows through the same schema as json', () => {
      const csv = ['externalId,sellerPublicKey,amount', 'A,NOT-A-KEY,5'].join('\n');
      return service.run({ format: 'csv', payload: csv }).then((plan) => {
        assert.equal(plan.counts.error, 1);
        assert.match(plan.rows[0].reason!, /sellerPublicKey/);
      });
    });

    it('rejects a csv payload that is not a string', async () => {
      await assert.rejects(() => service.run({ format: 'csv', payload: { rows: [] } }), /raw CSV text/);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Envelope forms                                                    */
  /* ---------------------------------------------------------------- */

  describe('json envelopes', () => {
    it('accepts a rows array and an invoices array', async () => {
      const a = await service.run({ payload: { rows: [row({ externalId: 'A' })] }, dryRun: false });
      const b = await service.run({ payload: { invoices: [row({ externalId: 'B' })] }, dryRun: false });

      assert.equal(a.counts.create, 1);
      assert.equal(b.counts.create, 1);
      assert.equal(store.size(), 2);
    });

    it('accepts a JSON string payload', async () => {
      const plan = await service.run({ payload: JSON.stringify([row()]), dryRun: false });
      assert.equal(plan.counts.create, 1);
    });

    it('rejects malformed JSON with a usable message', async () => {
      await assert.rejects(() => service.run({ payload: '{not json' }), /not valid JSON/);
    });
  });
});
