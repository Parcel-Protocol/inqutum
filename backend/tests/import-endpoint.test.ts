import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import { createImportRouter } from '../src/routes/import.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';
import express from 'express';

const SELLER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const post = (port: number, body: any) => new Promise<any>((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ port, path: '/api/imports/invoices', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
  req.on('error', reject); req.end(data);
});

describe('import endpoint over HTTP', () => {
  it('defaults to a dry run and writes nothing', async () => {
    const store = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(store));
    const app = express();
    app.use(express.json());
    app.use('/api', createImportRouter({ storage }));
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const port = (server.address() as any).port;

    try {
      const payload = { payload: [{ externalId: 'INV-1', sellerPublicKey: SELLER, amount: 25 }] };

      const dry = await post(port, payload);
      assert.equal(dry.status, 200);
      assert.equal(dry.body.data.dryRun, true);
      assert.deepEqual(dry.body.data.counts, { create: 1, update: 0, skip: 0, error: 0 });
      assert.equal(store.size(), 0, 'HTTP dry run must not write');
      assert.match(dry.body.message, /Nothing was written/);

      const applied = await post(port, { ...payload, dryRun: false });
      assert.equal(applied.body.data.dryRun, false);
      assert.equal(applied.body.data.counts.create, 1);
      assert.equal(store.size(), 1);
      assert.equal(applied.body.data.rollback.invoiceIds.length, 1);

      // idempotent re-post
      const again = await post(port, { ...payload, dryRun: false });
      assert.deepEqual(again.body.data.counts, { create: 0, update: 0, skip: 1, error: 0 });
      assert.equal(store.size(), 1);
    } finally {
      server.close();
    }
  });

  it('returns 400 with recovery guidance for a bad payload', async () => {
    const store = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(store));
    const app = express();
    app.use(express.json());
    app.use('/api', createImportRouter({ storage }));
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const port = (server.address() as any).port;
    try {
      const res = await post(port, { payload: [{ id: 'x', memo: 'm', status: 'PENDING' }] });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /read-only projection/);
      assert.match(res.body.recoveryAction, /idempotent/);
    } finally {
      server.close();
    }
  });
});
