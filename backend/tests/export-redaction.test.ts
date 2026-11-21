/**
 * Permission-aware export with field redaction (#354).
 *
 * Normal (owner sees everything), failure (forbidden / unauthenticated),
 * retry (idempotent regeneration, expiry then regenerate) and authorization
 * (operator view, wallet binding, ownership of artifacts) paths.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@stellar/stellar-sdk';
import { ExportService, ExportForbiddenError, toExportRecord, EXPORT_FIELDS } from '../src/exports/export-service.ts';
import {
  FIELD_POLICY,
  REDACTED_MARKER,
  effectiveVisibility,
  isExportField,
  maskValue,
  redactRecord,
  resolveExportAccess,
  restrictedFields,
} from '../src/exports/export-field-policy.ts';
import { createExportRouter } from '../src/routes/export.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';
import { issueSessionToken } from '../src/auth/session-token.ts';
import { loadAuthConfig } from '../src/auth/config.ts';

const SELLER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const MAINTAINER_TOKEN = 'm'.repeat(32);
const SERVICE_TOKEN = 's'.repeat(32);
const SECRET_NOTE = 'Call Dana on +1-555-0100 about the deposit';

describe('field policy', () => {
  const full = (over: Record<string, string | number | null> = {}) =>
    ({
      id: 'inv-1',
      memo: 'QTN-ABCDEF123456',
      status: 'PAID',
      amount: 12.5,
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      description: SECRET_NOTE,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
      paidAt: '2026-01-02T00:00:00.000Z',
      paymentTxHash: 'a'.repeat(64),
      ...over,
    }) as ReturnType<typeof toExportRecord>;

  it('owner sees every field untouched', () => {
    const { record, redacted } = redactRecord(full(), 'owner');
    assert.deepEqual(record, full());
    assert.deepEqual(redacted, []);
    assert.deepEqual(restrictedFields('owner'), []);
  });

  it('operator gets a masked memo and no description, everything else intact', () => {
    const { record, redacted } = redactRecord(full(), 'operator');
    assert.equal(record.memo, `QTN-${REDACTED_MARKER}`);
    assert.equal(record.description, REDACTED_MARKER);
    assert.equal(record.amount, 12.5);
    assert.equal(record.paymentTxHash, 'a'.repeat(64));
    assert.deepEqual(redacted, ['memo', 'description']);
    assert.ok(!JSON.stringify(record).includes('Dana'));
    assert.ok(!JSON.stringify(record).includes('ABCDEF123456'));
  });

  it('never mutates its input and keeps every column', () => {
    const input = full();
    const snapshot = { ...input };
    const { record } = redactRecord(input, 'operator', ['amount']);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(Object.keys(record), [...EXPORT_FIELDS]);
    assert.equal(record.amount, REDACTED_MARKER);
  });

  it('extra redactions narrow an owner view; null values stay null', () => {
    const { record, redacted } = redactRecord(full({ paidAt: null, paymentTxHash: null }), 'owner', ['paidAt', 'description', 'paymentTxHash']);
    assert.equal(record.description, REDACTED_MARKER);
    assert.equal(record.paidAt, null, 'nothing to hide');
    assert.deepEqual(redacted, ['description']);
  });

  it('short values are fully redacted rather than half-revealed; masking handles numbers and null', () => {
    assert.equal(maskValue('short'), REDACTED_MARKER);
    assert.equal(maskValue('12345678'), `1234${REDACTED_MARKER}`);
    assert.equal(maskValue(123456789), `1234${REDACTED_MARKER}`);
    assert.equal(maskValue(null), null);
  });

  it('requests can only narrow: an operator never gets more than the policy allows', () => {
    assert.equal(effectiveVisibility('operator', 'description', []), 'redacted');
    assert.equal(effectiveVisibility('operator', 'memo', []), 'masked');
    assert.equal(effectiveVisibility('operator', 'memo', ['memo']), 'redacted');
    assert.equal(effectiveVisibility('owner', 'memo', ['memo']), 'redacted');
    assert.deepEqual(restrictedFields('operator'), ['memo', 'description']);
  });

  it('an unknown viewer fails closed to redacted', () => {
    assert.equal(effectiveVisibility('stranger' as never, 'amount'), 'redacted');
    const { record } = redactRecord(full(), 'stranger' as never);
    for (const field of EXPORT_FIELDS) assert.equal(record[field], REDACTED_MARKER);
  });

  it('every allow-listed field has a policy for every viewer', () => {
    for (const viewer of ['owner', 'operator', 'public'] as const) {
      assert.deepEqual(Object.keys(FIELD_POLICY[viewer]).sort(), [...EXPORT_FIELDS].sort());
    }
    assert.equal(isExportField('memo'), true);
    assert.equal(isExportField('sellerEmail'), false);
    assert.equal(isExportField(5), false);
  });

  it('regression: no-credentials caller is never more privileged than an operator', () => {
    const anon = resolveExportAccess({ actor: undefined, requester: SELLER });
    assert.ok(anon.ok && anon.viewer === 'public');
    const anonView = redactRecord(full(), 'public').record;
    const operatorView = redactRecord(full(), 'operator').record;
    assert.equal(anonView.description, REDACTED_MARKER);
    for (const f of EXPORT_FIELDS) {
      if (operatorView[f] === REDACTED_MARKER) assert.equal(anonView[f], REDACTED_MARKER);
    }
  });
});

describe('resolveExportAccess', () => {
  const wallet = Keypair.random().publicKey();
  const endUser = { role: 'end_user' as const, subject: wallet, wallet };

  it('anonymous (legacy): asserting a wallet yields only the public view, another wallet forbidden', () => {
    assert.deepEqual(resolveExportAccess({ actor: undefined, requester: SELLER }), { ok: true, viewer: 'public', scope: SELLER, owner: SELLER });
    assert.deepEqual(resolveExportAccess({ actor: { role: 'anonymous', subject: 'anonymous' } as never, requester: SELLER }), { ok: true, viewer: 'public', scope: SELLER, owner: SELLER });
    const denied = resolveExportAccess({ actor: undefined, requester: SELLER, scope: OTHER });
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.code, 'EXPORT_FORBIDDEN');
  });

  it('end_user is bound to their own wallet', () => {
    assert.deepEqual(resolveExportAccess({ actor: endUser, requester: wallet }), { ok: true, viewer: 'owner', scope: wallet, owner: wallet });
    assert.equal(resolveExportAccess({ actor: endUser, requester: OTHER }).ok, false, 'claiming another wallet');
    assert.equal(resolveExportAccess({ actor: endUser, requester: wallet, scope: OTHER }).ok, false, 'exporting another scope');
    assert.equal(resolveExportAccess({ actor: { role: 'end_user', subject: 'x' }, requester: wallet }).ok, false, 'no wallet on actor');
  });

  it('maintainer and service export any scope as operator and own the artifact', () => {
    for (const role of ['maintainer', 'service'] as const) {
      const access = resolveExportAccess({ actor: { role, subject: `${role}:abcd` }, requester: SELLER, scope: OTHER });
      assert.deepEqual(access, { ok: true, viewer: 'operator', scope: OTHER, owner: `${role}:abcd` });
    }
  });

  it('a failed credential is a 401, even when the caller asks for their own wallet', () => {
    const access = resolveExportAccess({ actor: undefined, authFailed: true, requester: SELLER });
    assert.equal(!access.ok && access.code, 'EXPORT_UNAUTHENTICATED');
  });

  it('an unrecognised role is refused', () => {
    const access = resolveExportAccess({ actor: { role: 'auditor' as never, subject: 'a' }, requester: SELLER });
    assert.equal(!access.ok && access.code, 'EXPORT_FORBIDDEN');
  });
});

describe('ExportService with viewers', () => {
  let storage: MemoryInvoiceStorage;
  beforeEach(async () => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
    await storage.createInvoice({ amount: 5, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7, description: SECRET_NOTE } as never);
    await storage.createInvoice({ amount: 7, assetCode: 'XLM', sellerPublicKey: OTHER, expiresInDays: 7, description: 'other seller note' } as never);
  });

  it('records the viewer and redacted fields in the metadata and the file', async () => {
    const artifact = await new ExportService(storage).create(SELLER, { format: 'json' });
    const doc = JSON.parse(artifact.body);
    assert.equal(doc.viewer, 'owner');
    assert.deepEqual(doc.redactedFields, []);
    assert.equal(doc.records[0].description, SECRET_NOTE);
  });

  it('owner-requested redaction blanks the column in JSON and CSV', async () => {
    const service = new ExportService(storage);
    const json = JSON.parse((await service.create(SELLER, { format: 'json', redactFields: ['description', 'amount'] })).body);
    assert.deepEqual(json.redactedFields, ['amount', 'description']);
    assert.equal(json.records[0].description, REDACTED_MARKER);
    assert.equal(json.records[0].amount, REDACTED_MARKER);

    const csv = (await service.create(SELLER, { format: 'csv', redactFields: ['description'] })).body;
    assert.ok(csv.includes(REDACTED_MARKER));
    assert.ok(!csv.includes('Dana'));
  });

  it('ignores unknown redactFields instead of failing open or crashing', async () => {
    const doc = JSON.parse((await new ExportService(storage).create(SELLER, { format: 'json', redactFields: ['nope' as never] })).body);
    assert.deepEqual(doc.redactedFields, []);
  });

  it('operator view exports another seller redacted and the artifact belongs to the operator', async () => {
    const service = new ExportService(storage);
    const artifact = await service.create('maintainer:abcd', { format: 'json' }, SELLER, undefined, { viewer: 'operator' });
    const doc = JSON.parse(artifact.body);
    assert.equal(doc.viewer, 'operator');
    assert.deepEqual(doc.scope, { sellerPublicKey: SELLER });
    assert.equal(doc.records.length, 1, 'only the scoped seller');
    assert.equal(doc.records[0].description, REDACTED_MARKER);
    assert.ok(!artifact.body.includes('Dana'));
    assert.ok(!artifact.body.includes('other seller note'));
    assert.equal(service.get('maintainer:abcd', doc.exportId).state, 'ok');
    assert.equal(service.get(SELLER, doc.exportId).state, 'not_found', 'the seller cannot fetch the operator copy');
  });

  it('an owner still cannot export another scope (the viewer is not request-controlled)', async () => {
    await assert.rejects(new ExportService(storage).create(SELLER, { format: 'json' }, OTHER, undefined, { viewer: 'owner' }), ExportForbiddenError);
    await assert.rejects(new ExportService(storage).create(SELLER, { format: 'json' }, OTHER), ExportForbiddenError);
  });
});

describe('export routes: permission-aware access', () => {
  const env = { ...process.env };
  let storage: MemoryInvoiceStorage;
  let service: ExportService;
  let server: import('node:http').Server;
  let base: string;
  const audits: any[] = [];

  beforeEach(async () => {
    process.env.AUTH_SESSION_SECRET = 'z'.repeat(40);
    process.env.MAINTAINER_API_TOKENS = MAINTAINER_TOKEN;
    process.env.SERVICE_API_TOKENS = SERVICE_TOKEN;
    memoryStorage.clear();
    audits.length = 0;
    storage = new MemoryInvoiceStorage();
    (storage as any).recordAuditEvent = async (event: unknown) => void audits.push(event);
    await storage.createInvoice({ amount: 5, assetCode: 'XLM', sellerPublicKey: SELLER, expiresInDays: 7, description: SECRET_NOTE } as never);
    service = new ExportService(storage);
    const app = express();
    app.use(express.json());
    app.use('/api', createExportRouter({ storage, service }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of ['AUTH_SESSION_SECRET', 'MAINTAINER_API_TOKENS', 'SERVICE_API_TOKENS']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  const post = (body: unknown, token?: string) =>
    fetch(`${base}/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const sessionFor = (wallet: string) => issueSessionToken(loadAuthConfig().sessionSecret!, wallet, { ttlSeconds: 600 }).token;

  it('legacy unauthenticated export still works but is redacted: a wallet string is not ownership', async () => {
    const res = await post({ requester: SELLER });
    assert.equal(res.status, 201);
    const meta = (await res.json()).data;
    assert.equal(meta.viewer, 'public');
    assert.ok(meta.redactedFields.includes('description'));
    const file = await fetch(`${base}${meta.downloadPath.replace('/api', '')}`);
    const text = await file.text();
    assert.ok(!text.includes('Dana'));
    assert.ok(text.includes(REDACTED_MARKER));
  });

  it('owner redactFields are applied to the downloaded file and audited', async () => {
    const res = await post({ requester: SELLER, redactFields: ['description'] }, sessionFor(SELLER));
    const meta = (await res.json()).data;
    assert.deepEqual(meta.redactedFields, ['description']);
    const body = await (await fetch(`${base}${meta.downloadPath.replace('/api', '')}`)).text();
    assert.ok(!body.includes('Dana'));
    assert.ok(body.includes(REDACTED_MARKER));
    const event = audits.at(-1);
    assert.equal(event.actor.type, 'seller');
    assert.deepEqual(event.metadata.redactedFields, ['description']);
    assert.equal(event.metadata.viewer, 'owner');
  });

  it('rejects redactFields that are not export columns', async () => {
    const res = await post({ requester: SELLER, redactFields: ['sellerEmail'] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_EXPORT_REQUEST');
  });

  it('end_user session: own wallet in full; another wallet is 403', async () => {
    const wallet = Keypair.random().publicKey();
    const token = sessionFor(wallet);
    await storage.createInvoice({ amount: 1, assetCode: 'XLM', sellerPublicKey: wallet, expiresInDays: 7, description: 'mine' } as never);

    const ok = await post({ requester: wallet }, token);
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).data.viewer, 'owner');

    const spoof = await post({ requester: SELLER }, token);
    assert.equal(spoof.status, 403);
    assert.equal((await spoof.json()).code, 'EXPORT_FORBIDDEN');
    assert.equal(service.size(), 1, 'no artifact for the spoofed request');
  });

  it('an invalid or expired credential is 401, not a fallback to the legacy path', async () => {
    const res = await post({ requester: SELLER }, 'not-a-real-token-not-a-real-token');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await res.json()).code, 'EXPORT_UNAUTHENTICATED');
    assert.equal(service.size(), 0);

    const download = await fetch(`${base}/exports/some-id?requester=${SELLER}`, { headers: { authorization: 'Bearer bad-bad-bad-bad-bad-bad-bad' } });
    assert.equal(download.status, 401);
  });

  it('maintainer exports another seller redacted, owns the file, and the seller cannot download it', async () => {
    const res = await post({ requester: SELLER }, MAINTAINER_TOKEN);
    assert.equal(res.status, 201);
    const meta = (await res.json()).data;
    assert.equal(meta.viewer, 'operator');
    assert.deepEqual(meta.redactedFields, ['memo', 'description']);
    assert.ok(!meta.downloadPath.includes('requester='));

    const file = await fetch(`${base}${meta.downloadPath.replace('/api', '')}`, { headers: { authorization: `Bearer ${MAINTAINER_TOKEN}` } });
    assert.equal(file.status, 200);
    const text = await file.text();
    assert.ok(!text.includes('Dana'));
    assert.ok(text.includes(REDACTED_MARKER));

    const asSeller = await fetch(`${base}/exports/${meta.exportId}?requester=${SELLER}`);
    assert.equal(asSeller.status, 404);
    const asOtherToken = await fetch(`${base}/exports/${meta.exportId}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    assert.equal(asOtherToken.status, 404, 'a different operator cannot fetch it either');

    const event = audits.at(-1);
    assert.equal(event.actor.type, 'maintainer');
    assert.equal(event.metadata.exportedWallet, SELLER);
    assert.equal(event.metadata.viewer, 'operator');
  });

  it('service tokens also get the operator view; sellerPublicKey picks the target scope', async () => {
    const res = await post({ requester: OTHER, sellerPublicKey: SELLER }, SERVICE_TOKEN);
    assert.equal(res.status, 201);
    const meta = (await res.json()).data;
    assert.equal(meta.viewer, 'operator');
    assert.equal(meta.scope.sellerPublicKey, SELLER);
  });

  it("another wallet's session cannot download an owner artifact (404, same as unknown)", async () => {
    const owner = Keypair.random().publicKey();
    const intruder = Keypair.random().publicKey();
    const meta = (await (await post({ requester: owner }, sessionFor(owner))).json()).data;

    const ok = await fetch(`${base}/exports/${meta.exportId}?requester=${owner}`, { headers: { authorization: `Bearer ${sessionFor(owner)}` } });
    assert.equal(ok.status, 200);
    const stolen = await fetch(`${base}/exports/${meta.exportId}?requester=${owner}`, { headers: { authorization: `Bearer ${sessionFor(intruder)}` } });
    assert.equal(stolen.status, 404);
    const missing = await fetch(`${base}/exports/${meta.exportId}`, { headers: { authorization: `Bearer ${sessionFor(owner)}` } });
    assert.equal(missing.status, 400, 'a wallet session still has to name its wallet');
  });

  it('retry: regenerating after a failure yields a fresh, equally redacted artifact', async () => {
    const first = (await (await post({ requester: SELLER, redactFields: ['memo'] }, MAINTAINER_TOKEN)).json()).data;
    const second = (await (await post({ requester: SELLER, redactFields: ['memo'] }, MAINTAINER_TOKEN)).json()).data;
    assert.notEqual(first.exportId, second.exportId);
    assert.deepEqual(first.redactedFields, second.redactedFields);
  });
});
