import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { DEFAULT_STALE_GRACE_MS, reconcile } from '../src/domain/reconciliation.ts';
import type {
  FindingCode,
  ReconciliationInput,
  ReconciliationInvoice,
  ReconciliationSettlement,
} from '../src/domain/reconciliation.ts';
import { runReconciliation } from '../src/services/reconciliation.service.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';
import { InvoiceService } from '../src/services/invoice.service.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { PostgresInvoiceStorage } from '../src/storage/postgres-invoice-storage.ts';
import { createReconciliationRouter } from '../src/routes/reconciliation.routes.ts';
import { exitCodeFor, formatReport, main } from '../scripts/reconcile.ts';
import { FakeInvoiceDb } from './fixtures/fake-invoice-db.fixture.ts';
import { maintainerAuth, serviceAuth, walletAuth } from './fixtures/auth.fixture.ts';

for (const method of ['log', 'warn', 'error'] as const) {
  console[method] = () => undefined;
}

const NOW = new Date('2026-09-01T12:00:00.000Z');
const SELLER = 'G' + 'A'.repeat(55);
const OTHER = 'G' + 'B'.repeat(55);
const PAYER = 'G' + 'C'.repeat(55);
const ISSUER = 'G' + 'D'.repeat(55);
const HOUR = 3_600_000;
const tx = (n: number) => n.toString(16).padStart(64, '0');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

let counter = 0;
function pending(overrides: Partial<ReconciliationInvoice> = {}): ReconciliationInvoice {
  counter += 1;
  return {
    id: `inv-${counter}`,
    sellerPublicKey: SELLER,
    amount: '10.0000000',
    assetCode: 'XLM',
    memo: `INV-MEMO-${counter}`,
    status: 'PENDING',
    expiresAt: iso(24 * HOUR),
    ...overrides,
  };
}

function paid(txHash: string, overrides: Partial<ReconciliationInvoice> = {}): ReconciliationInvoice {
  return pending({
    status: 'PAID',
    paymentTxHash: txHash,
    payerPublicKey: PAYER,
    paidAt: iso(-HOUR),
    ...overrides,
  });
}

const settlementFor = (invoice: ReconciliationInvoice, overrides: Partial<ReconciliationSettlement> = {}): ReconciliationSettlement => ({
  txHash: invoice.paymentTxHash ?? tx(999),
  invoiceId: invoice.id,
  destination: invoice.sellerPublicKey,
  amount: invoice.amount,
  assetCode: invoice.assetCode ?? 'XLM',
  assetIssuer: invoice.assetIssuer ?? null,
  memo: invoice.memo,
  ...overrides,
});

const audit = (invoiceId: string, eventType: string, eventData: Record<string, unknown> | null = null) => ({
  invoiceId,
  eventType,
  eventData,
});

const run = (overrides: Partial<ReconciliationInput> = {}) =>
  reconcile({
    invoices: [],
    auditEvents: null,
    settlements: null,
    reportedRevenue: null,
    now: NOW,
    ...overrides,
  });

const codes = (report: ReturnType<typeof reconcile>) => report.findings.map((f) => f.code);
const find = (report: ReturnType<typeof reconcile>, code: FindingCode) =>
  report.findings.find((f) => f.code === code);

describe('reconciliation: a healthy system reports nothing', () => {
  it('is clean for a consistent set across every lifecycle path', () => {
    const settled = paid(tx(1));
    const cancelled = pending({ status: 'CANCELLED', cancelledAt: iso(-2 * HOUR) });
    const expired = pending({ status: 'EXPIRED', expiresAt: iso(-3 * HOUR) });
    const lateAfterCancel = paid(tx(2), {
      priorStatus: 'CANCELLED',
      cancelledAt: iso(-5 * HOUR),
      settledAt: iso(-4 * HOUR),
      settlementContext: 'AFTER_CANCEL',
    });
    const invoices = [settled, cancelled, expired, lateAfterCancel, pending()];

    const report = run({
      invoices,
      auditEvents: [
        audit(settled.id, 'PAYMENT_CONFIRMED', { txHash: tx(1) }),
        audit(cancelled.id, 'INVOICE_CANCELLED'),
        audit(expired.id, 'INVOICE_EXPIRED'),
        audit(lateAfterCancel.id, 'PAYMENT_CONFIRMED', { txHash: tx(2) }),
      ],
      settlements: [settlementFor(settled), settlementFor(lateAfterCancel)],
      reportedRevenue: { [SELLER]: { XLM: 20 } },
    });

    assert.deepEqual(report.findings, []);
    assert.equal(report.clean, true);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.checksRun, { invoiceIntegrity: true, audit: true, ledger: true, balances: true });
  });

  it('is clean for no data at all', () => {
    assert.equal(run().clean, true);
  });
});

describe('reconciliation: drift scenarios', () => {
  // 1 -------------------------------------------------------------------
  it('inconsistent: a PAID invoice missing its payment fields', () => {
    const broken = paid(tx(1), { paymentTxHash: null, payerPublicKey: null, paidAt: null });
    const report = run({ invoices: [broken] });

    const finding = find(report, 'PAID_MISSING_PAYMENT_FIELDS')!;
    assert.equal(finding.category, 'inconsistent');
    assert.equal(finding.severity, 'error');
    assert.equal(finding.invoiceId, broken.id);
    assert.deepEqual(finding.details?.missing, ['paymentTxHash', 'payerPublicKey', 'paidAt']);
    assert.match(finding.repair, /payment_events/);
  });

  // 2 -------------------------------------------------------------------
  it('duplicate: one on-chain payment recorded against two invoices', () => {
    const a = paid(tx(7));
    const b = paid(tx(7));
    const report = run({ invoices: [a, b] });

    const finding = find(report, 'DUPLICATE_PAYMENT_TX')!;
    assert.equal(finding.category, 'duplicate');
    assert.equal(finding.txHash, tx(7));
    assert.deepEqual(finding.details?.invoiceIds, [a.id, b.id]);
  });

  // 3 -------------------------------------------------------------------
  it('stale: a PENDING invoice past its expiry that was never swept', () => {
    const overdue = pending({ expiresAt: iso(-2 * HOUR) });
    const fresh = pending({ expiresAt: iso(HOUR) });
    const report = run({ invoices: [overdue, fresh] });

    assert.deepEqual(codes(report), ['PENDING_PAST_EXPIRY']);
    assert.equal(report.findings[0].category, 'stale');
    assert.equal(report.findings[0].invoiceId, overdue.id);
  });

  it('stale: tolerates the normal lag of the expiry sweep', () => {
    const justExpired = pending({ expiresAt: new Date(NOW.getTime() - DEFAULT_STALE_GRACE_MS + 1000).toISOString() });
    assert.equal(run({ invoices: [justExpired] }).clean, true);

    const wider = run({ invoices: [pending({ expiresAt: iso(-HOUR) })], staleGraceMs: 2 * HOUR });
    assert.equal(wider.clean, true, 'a configured grace window is honoured');
  });

  // 4 -------------------------------------------------------------------
  it('missing: funds on file for an invoice that was never marked PAID', () => {
    const invoice = pending();
    const report = run({
      invoices: [invoice],
      settlements: [settlementFor(invoice, { txHash: tx(42) })],
    });

    const finding = find(report, 'SETTLEMENT_UNAPPLIED')!;
    assert.equal(finding.category, 'missing');
    assert.equal(finding.severity, 'error');
    assert.equal(finding.invoiceId, invoice.id);
    assert.equal(finding.txHash, tx(42));
    assert.match(finding.repair, /verify path/);
  });

  it('missing: a PAID invoice with no settlement record is only a warning', () => {
    const invoice = paid(tx(3));
    const report = run({ invoices: [invoice], settlements: [] });

    const finding = find(report, 'PAID_WITHOUT_SETTLEMENT_RECORD')!;
    assert.equal(finding.category, 'missing');
    assert.equal(finding.severity, 'warning', 'the verify endpoint does not always write the ledger table');
  });

  it('missing: a payment for an invoice memo that matches no invoice', () => {
    const report = run({
      invoices: [],
      settlements: [{ txHash: tx(5), amount: '3', memo: 'INV-NOBODY', destination: SELLER }],
    });
    assert.deepEqual(codes(report), ['SETTLEMENT_UNKNOWN_INVOICE']);
  });

  it('does not flag unrelated payments that carry no invoice memo', () => {
    const report = run({
      invoices: [],
      settlements: [{ txHash: tx(5), amount: '3', memo: 'rent for august', destination: SELLER }],
    });
    assert.equal(report.clean, true);
  });

  // 5 -------------------------------------------------------------------
  it('inconsistent: settlement amount differs from the invoice, to the stroop', () => {
    const invoice = paid(tx(4), { amount: '10.0000000' });
    const report = run({
      invoices: [invoice],
      settlements: [settlementFor(invoice, { amount: '9.9999999' })],
    });

    const finding = find(report, 'LEDGER_AMOUNT_MISMATCH')!;
    assert.equal(finding.category, 'inconsistent');
    assert.equal(finding.details?.differenceStroops, '-1');
  });

  it('inconsistent: settlement in a different asset, to a different account, or with a different memo', () => {
    const invoice = paid(tx(6), { assetCode: 'USDC', assetIssuer: ISSUER });
    const report = run({
      invoices: [invoice],
      settlements: [
        settlementFor(invoice, { assetCode: 'XLM', assetIssuer: null, destination: OTHER, memo: 'INV-OTHER' }),
      ],
    });
    assert.deepEqual(
      codes(report).sort(),
      ['LEDGER_ASSET_MISMATCH', 'LEDGER_DESTINATION_MISMATCH', 'LEDGER_MEMO_MISMATCH']
    );
  });

  it('inconsistent: a credit asset with the same code but another issuer does not match', () => {
    const invoice = paid(tx(6), { assetCode: 'USDC', assetIssuer: ISSUER });
    const report = run({
      invoices: [invoice],
      settlements: [settlementFor(invoice, { assetIssuer: OTHER })],
    });
    assert.deepEqual(codes(report), ['LEDGER_ASSET_MISMATCH']);
  });

  // 6 -------------------------------------------------------------------
  it('inconsistent: the balance a seller sees differs from their PAID invoices', () => {
    const invoices = [paid(tx(1), { amount: '10.0000000' }), paid(tx(2), { amount: '5.5000000' })];
    const report = run({ invoices, reportedRevenue: { [SELLER]: { XLM: 10 } } });

    const finding = find(report, 'REVENUE_MISMATCH')!;
    assert.equal(finding.category, 'inconsistent');
    assert.deepEqual(finding.details, { seller: SELLER, asset: 'XLM', shown: 10, derived: '15.5000000' });
  });

  it('inconsistent: a seller shown revenue in an asset with no PAID invoices, or none they should see', () => {
    const report = run({
      invoices: [paid(tx(1))],
      reportedRevenue: { [SELLER]: { XLM: 10, USDC: 4 }, [OTHER]: { XLM: 1 } },
    });
    assert.deepEqual(
      report.findings.map((f) => [f.details?.seller, f.details?.asset]),
      [[SELLER, 'USDC'], [OTHER, 'XLM']]
    );
  });

  it('sums amounts exactly, so float error never invents drift', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in stroops it is exact.
    const invoices = [paid(tx(1), { amount: 0.1 }), paid(tx(2), { amount: 0.2 })];
    assert.equal(run({ invoices, reportedRevenue: { [SELLER]: { XLM: 0.3 } } }).clean, true);
  });

  // 7 -------------------------------------------------------------------
  it('duplicate: two invoices sharing a memo, and a repeated invoice id', () => {
    const a = pending({ memo: 'INV-SAME' });
    const b = pending({ memo: 'INV-SAME' });
    const c = pending({ id: a.id });
    const report = run({ invoices: [a, b, c] });
    assert.ok(codes(report).includes('DUPLICATE_MEMO'));
    assert.ok(codes(report).includes('DUPLICATE_INVOICE_ID'));
  });

  it('duplicate: the same transaction listed twice in the settlement records', () => {
    const invoice = paid(tx(1));
    const report = run({
      invoices: [invoice],
      settlements: [settlementFor(invoice), settlementFor(invoice)],
    });
    assert.deepEqual(codes(report), ['DUPLICATE_SETTLEMENT_RECORD']);
  });

  // 8 -------------------------------------------------------------------
  it('inconsistent: an unpaid invoice that carries payment data', () => {
    const report = run({ invoices: [pending({ status: 'EXPIRED', paymentTxHash: tx(9) })] });
    assert.deepEqual(codes(report), ['UNPAID_HAS_PAYMENT_FIELDS']);
  });

  it('inconsistent: an unknown status, and a cancelled invoice with no timestamp', () => {
    const report = run({
      invoices: [pending({ status: 'REFUNDED' }), pending({ status: 'CANCELLED', cancelledAt: null })],
    });
    assert.deepEqual(codes(report).sort(), ['CANCELLED_MISSING_TIMESTAMP', 'UNKNOWN_STATUS']);
  });

  it('inconsistent: settlement context contradicts the timestamps', () => {
    const wrong = paid(tx(1), {
      priorStatus: 'CANCELLED',
      cancelledAt: iso(-5 * HOUR),
      settledAt: iso(-4 * HOUR), // after the cancel
      settlementContext: 'ON_TIME',
    });
    const finding = find(run({ invoices: [wrong] }), 'SETTLEMENT_CONTEXT_MISMATCH')!;
    assert.deepEqual(finding.details, { recorded: 'ON_TIME', expected: 'AFTER_CANCEL' });
  });

  // audit --------------------------------------------------------------
  it('missing: a state with no audit event, as a warning', () => {
    const settled = paid(tx(1));
    const cancelled = pending({ status: 'CANCELLED', cancelledAt: iso(-HOUR) });
    const expired = pending({ status: 'EXPIRED' });
    const report = run({ invoices: [settled, cancelled, expired], auditEvents: [] });

    assert.deepEqual(
      report.findings.map((f) => `${f.code}:${f.details?.expectedEvent}`).sort(),
      [
        'AUDIT_EVENT_MISSING:INVOICE_CANCELLED',
        'AUDIT_EVENT_MISSING:INVOICE_EXPIRED',
        'AUDIT_EVENT_MISSING:PAYMENT_CONFIRMED',
      ]
    );
    assert.ok(report.findings.every((f) => f.severity === 'warning' && f.category === 'missing'));
  });

  it('inconsistent: audit trail and invoice disagree about the transaction', () => {
    const invoice = paid(tx(1));
    const report = run({
      invoices: [invoice],
      auditEvents: [audit(invoice.id, 'PAYMENT_CONFIRMED', { txHash: tx(2) })],
    });
    assert.deepEqual(codes(report), ['AUDIT_TX_MISMATCH']);
  });

  it('inconsistent: audit events for an invoice that does not exist', () => {
    const report = run({ invoices: [], auditEvents: [audit('ghost', 'INVOICE_CANCELLED')] });
    assert.deepEqual(codes(report), ['AUDIT_ORPHAN']);
  });
});

describe('reconciliation: report shape', () => {
  it('states which checks could not run instead of implying they passed', () => {
    const report = run({ invoices: [pending()] });
    assert.deepEqual(report.checksRun, { invoiceIntegrity: true, audit: false, ledger: false, balances: false });
    assert.deepEqual(report.checked, { invoices: 1, auditEvents: null, settlements: null, revenueSellers: null });
    assert.match(formatReport(report), /NOT verified.*audit, ledger, balances/);
  });

  it('counts findings by kind and severity, errors first', () => {
    const invoice = pending();
    const report = run({
      invoices: [invoice, pending({ expiresAt: iso(-HOUR) }), paid(tx(1), { paymentTxHash: null })],
      settlements: [settlementFor(invoice, { txHash: tx(50) })],
    });

    assert.equal(report.summary.total, report.findings.length);
    assert.equal(report.summary.byCategory.stale, 1);
    assert.equal(report.summary.byCategory.missing, 1);
    assert.equal(report.summary.byCategory.inconsistent, 1);
    const severities = report.findings.map((f) => f.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)));
  });

  it('is deterministic: the same data always yields the same report', () => {
    const input: Partial<ReconciliationInput> = {
      invoices: [paid(tx(1), { paymentTxHash: null }), pending({ expiresAt: iso(-HOUR) }), pending({ status: 'REFUNDED' })],
      auditEvents: [],
    };
    assert.deepEqual(run(input), run({ ...input, invoices: [...input.invoices!].reverse() }));
  });

  it('gives every finding actionable repair guidance', () => {
    const invoice = pending();
    const report = run({
      invoices: [
        invoice,
        paid(tx(1), { paymentTxHash: null }),
        paid(tx(2)),
        paid(tx(2)),
        pending({ memo: invoice.memo }),
        pending({ status: 'REFUNDED' }),
        pending({ expiresAt: iso(-HOUR) }),
      ],
      auditEvents: [audit('ghost', 'X')],
      settlements: [settlementFor(invoice, { txHash: tx(60), amount: '1' })],
      reportedRevenue: { [SELLER]: { XLM: 1 } },
    });
    assert.ok(report.findings.length > 5);
    for (const finding of report.findings) {
      assert.ok(finding.repair.length > 40, `${finding.code} has no real guidance`);
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee, against both backends
// ---------------------------------------------------------------------------

describe('reconciliation is read-only', () => {
  it('memory: leaves a stale PENDING invoice untouched (unlike ordinary reads, which would sweep it)', async () => {
    const raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    const invoice = await storage.createInvoice({ amount: 5, sellerPublicKey: SELLER, expiresInDays: 1 } as any);
    raw.updateInvoice(invoice.id, { expiresAt: new Date(Date.now() - 2 * HOUR) });

    const report = await runReconciliation(storage);

    assert.deepEqual(codes(report), ['PENDING_PAST_EXPIRY']);
    assert.equal(raw.snapshotInvoices()[0].status, 'PENDING', 'the run must not sweep expiry');
    assert.equal(raw.snapshotAuditEvents().filter((e) => e.eventType === 'INVOICE_EXPIRED').length, 0);
  });

  it('postgres: issues only SELECT statements, never a write or a sweep', async () => {
    const db = new FakeInvoiceDb();
    const service = new InvoiceService(db);
    const created = await service.createInvoice({ amount: 5, sellerPublicKey: SELLER, expiresInDays: 1 } as any);
    db.backdateExpiry(created.id, 2 * HOUR);

    const statements: string[] = [];
    const spy = {
      async query(text: string, params?: any[]) {
        statements.push(text.replace(/\s+/g, ' ').trim());
        // Serve the reads the fake does not implement (reconciliation-only queries).
        if (/^SELECT \* FROM invoices ORDER BY/i.test(statements.at(-1)!)) {
          return { rows: db.rows.map((row) => ({ ...row })), rowCount: db.rows.length };
        }
        if (/^SELECT id, invoice_id, event_type, event_data, created_at FROM payment_events ORDER BY/i.test(statements.at(-1)!)) {
          return { rows: db.events.map((e) => ({ ...e })), rowCount: db.events.length };
        }
        if (/^SELECT tx_hash, invoice_id, to_address/i.test(statements.at(-1)!)) {
          return { rows: [], rowCount: 0 };
        }
        if (/^SELECT COUNT\(\*\) as total_invoices/i.test(statements.at(-1)!)) {
          return {
            rows: [{ total_invoices: '1', paid_invoices: '0', pending_invoices: '1', actionable_invoices: '1', expired_invoices: '0', revenue_by_asset: {} }],
            rowCount: 1,
          };
        }
        return db.query(text, params);
      },
    };
    const storage = new PostgresInvoiceStorage(new InvoiceService(spy));
    statements.length = 0;

    const report = await runReconciliation(storage);

    assert.ok(statements.length >= 4, 'it did read');
    for (const statement of statements) {
      assert.match(statement, /^SELECT /i, `a non-read statement was issued: ${statement}`);
    }
    assert.deepEqual(codes(report), ['PENDING_PAST_EXPIRY']);
    assert.equal(db.rows[0].status, 'PENDING', 'the stale row was not swept');
  });

  it('reads exact decimal amounts from postgres rather than rounding through a float', async () => {
    const db = new FakeInvoiceDb();
    const service = new InvoiceService(db);
    db.rows.push({
      id: 'x', seller_public_key: SELLER, amount: '123456789.1234567', asset_code: 'XLM', memo: 'INV-X',
      status: 'PENDING', expires_at: new Date(Date.now() + HOUR), payment_tx_hash: null,
    });
    const spy = {
      query: async (text: string, params?: any[]) =>
        /^\s*SELECT \* FROM invoices ORDER BY/i.test(text)
          ? { rows: db.rows.map((r) => ({ ...r })), rowCount: db.rows.length }
          : db.query(text, params),
    };
    const [invoice] = await new InvoiceService(spy).listInvoicesForReconciliation();
    assert.equal(invoice.amount, '123456789.1234567');
  });
});

// ---------------------------------------------------------------------------
// Both backends see the same drift
// ---------------------------------------------------------------------------

describe('reconciliation over real storages', () => {
  it('memory: a healthy lifecycle reconciles clean (audit trail and balances line up)', async () => {
    const raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    const a = await storage.createInvoice({ amount: 12.5, sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    const b = await storage.createInvoice({ amount: 3, sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    const c = await storage.createInvoice({ amount: 4, sellerPublicKey: OTHER, expiresInDays: 7 } as any);
    await storage.markAsPaid(a.id, tx(1), PAYER);
    await storage.cancelInvoice(b.id, SELLER);
    await storage.markAsPaid(c.id, tx(2), PAYER);

    const report = await runReconciliation(storage);

    assert.equal(report.findings.length, 0, JSON.stringify(report.findings, null, 2));
    assert.deepEqual(report.checksRun, { invoiceIntegrity: true, audit: true, ledger: false, balances: true });
  });

  it('memory: detects a tampered record', async () => {
    const raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    const a = await storage.createInvoice({ amount: 12.5, sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    await storage.markAsPaid(a.id, tx(1), PAYER);
    raw.updateInvoice(a.id, { amount: 99 }); // drift: amount edited after settlement

    const report = await runReconciliation(storage, {
      settlements: [{ txHash: tx(1), invoiceId: a.id, destination: SELLER, amount: '12.5000000', memo: a.memo }],
    });
    assert.deepEqual(codes(report), ['LEDGER_AMOUNT_MISMATCH']);
  });

  it('postgres double: reconciles a paid invoice against its transactions row', async () => {
    const db = new FakeInvoiceDb();
    const service = new InvoiceService(db);
    const created = await service.createInvoice({ amount: 10, sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    await service.markAsPaid(created.id, tx(1), PAYER);

    const spy = {
      query: async (text: string, params?: any[]) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (/^SELECT \* FROM invoices ORDER BY/i.test(sql)) return { rows: db.rows.map((r) => ({ ...r })), rowCount: db.rows.length };
        if (/^SELECT id, invoice_id, event_type, event_data, created_at FROM payment_events ORDER BY/i.test(sql)) {
          return { rows: db.events.map((e) => ({ ...e })), rowCount: db.events.length };
        }
        if (/^SELECT tx_hash, invoice_id, to_address/i.test(sql)) {
          return {
            rows: [{ tx_hash: tx(1), invoice_id: created.id, to_address: SELLER, amount: '10.0000000', asset_code: 'XLM', asset_issuer: null, memo: created.memo }],
            rowCount: 1,
          };
        }
        if (/^SELECT COUNT\(\*\) as total_invoices/i.test(sql)) {
          return { rows: [{ total_invoices: '1', paid_invoices: '1', pending_invoices: '0', actionable_invoices: '0', expired_invoices: '0', revenue_by_asset: { XLM: 10 } }], rowCount: 1 };
        }
        return db.query(text, params);
      },
    };
    const report = await runReconciliation(new PostgresInvoiceStorage(new InvoiceService(spy)));

    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.checksRun, { invoiceIntegrity: true, audit: true, ledger: true, balances: true });
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('reconciliation CLI', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };

  const exec = async (argv: string[], env: Record<string, string | undefined> = {}, openStorage?: any) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      env,
      now: () => NOW,
      openStorage,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('exits 0 on a clean snapshot without needing a database', async () => {
    const file = write('clean.json', { invoices: [pending()] });
    const result = await exec(['--input', file]);
    assert.equal(result.code, 0);
    assert.match(result.out, /No drift found/);
  });

  it('exits 1 and prints repair guidance when a snapshot has drift', async () => {
    const file = write('drift.json', { invoices: [paid(tx(1), { paymentTxHash: null })] });
    const result = await exec(['--input', file]);
    assert.equal(result.code, 1);
    assert.match(result.out, /\[ERROR\] inconsistent\/PAID_MISSING_PAYMENT_FIELDS/);
    assert.match(result.out, /Repair:/);
  });

  it('prints machine-readable JSON with --json', async () => {
    const file = write('json.json', { invoices: [pending({ expiresAt: iso(-HOUR) })] });
    const result = await exec(['--input', file, '--json']);
    const report = JSON.parse(result.out);
    assert.equal(report.dryRun, true);
    assert.equal(report.summary.byCategory.stale, 1);
    assert.equal(result.code, 0, 'a warning alone does not fail the default threshold');
  });

  it('--fail-on warning fails the run on a warning; --fail-on none never fails', async () => {
    const file = write('warn.json', { invoices: [pending({ expiresAt: iso(-HOUR) })] });
    assert.equal((await exec(['--input', file, '--fail-on', 'warning'])).code, 1);
    const drift = write('err.json', { invoices: [paid(tx(1), { paymentTxHash: null })] });
    assert.equal((await exec(['--input', drift, '--fail-on', 'none'])).code, 0);
  });

  it('checks a snapshot against an exported settlements file', async () => {
    const invoice = pending();
    const file = write('snap.json', { invoices: [invoice] });
    const ledger = write('ledger.json', [settlementFor(invoice, { txHash: tx(77) })]);
    const result = await exec(['--input', file, '--settlements', ledger]);
    assert.equal(result.code, 1);
    assert.match(result.out, /SETTLEMENT_UNAPPLIED/);
  });

  it('honours --stale-grace-minutes', async () => {
    const file = write('grace.json', { invoices: [pending({ expiresAt: iso(-30 * 60_000) })] });
    assert.match((await exec(['--input', file, '--stale-grace-minutes', '10', '--json'])).out, /PENDING_PAST_EXPIRY/);
    assert.match((await exec(['--input', file, '--stale-grace-minutes', '60', '--json'])).out, /"clean": true/);
  });

  it('reads a database through the injected storage when DATABASE_URL is set', async () => {
    const raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    await storage.createInvoice({ amount: 1, sellerPublicKey: SELLER, expiresInDays: 7 } as any);
    let closed = false;
    const result = await exec([], { DATABASE_URL: 'postgres://x' }, async (url: string) => {
      assert.equal(url, 'postgres://x');
      return { storage, close: async () => void (closed = true) };
    });
    assert.equal(result.code, 0);
    assert.equal(closed, true, 'the connection is always released');
  });

  it('exits 2 for usage and input errors, never 0 or 1', async () => {
    assert.equal((await exec([])).code, 2, 'no input and no DATABASE_URL');
    assert.equal((await exec(['--bogus'])).code, 2);
    assert.equal((await exec(['--fail-on', 'sometimes'])).code, 2);
    assert.equal((await exec(['--input', path.join(dir, 'missing.json')])).code, 2);
    assert.equal((await exec(['--input', write('bad.json', { nope: true })])).code, 2);
    assert.equal((await exec(['--input', write('g.json', { invoices: [] }), '--stale-grace-minutes', 'x'])).code, 2);
  });

  it('exits 2 and still closes the connection when the read fails', async () => {
    let closed = false;
    const result = await exec([], { DATABASE_URL: 'postgres://x' }, async () => ({
      storage: {
        listInvoicesForReconciliation: async () => {
          throw new Error('connection reset');
        },
      },
      close: async () => void (closed = true),
    }));
    assert.equal(result.code, 2);
    assert.match(result.err, /connection reset/);
    assert.equal(closed, true);
  });

  it('prints help', async () => {
    const result = await exec(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.out, /read-only/);
  });

  it('exitCodeFor distinguishes errors from warnings', () => {
    const warningOnly = run({ invoices: [pending({ expiresAt: iso(-HOUR) })] });
    assert.equal(exitCodeFor(warningOnly, 'error'), 0);
    assert.equal(exitCodeFor(warningOnly, 'warning'), 1);
    assert.equal(exitCodeFor(warningOnly, 'none'), 0);
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('GET /reconciliation', () => {
  let server: http.Server;
  let baseUrl: string;
  let raw: MemoryStorage;

  before(async () => {
    raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    const app = express();
    app.use('/api', createReconciliationRouter({ storage }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, { headers });

  it('refuses anonymous callers and sellers', async () => {
    assert.equal((await get('/reconciliation')).status, 401);
    // A signed-in seller is authenticated but not permitted (403, not 401).
    assert.equal((await get('/reconciliation', walletAuth(Keypair.random().publicKey()))).status, 403);
  });

  it('serves the report to maintainers and services', async () => {
    for (const headers of [maintainerAuth(), serviceAuth()]) {
      const response = await get('/reconciliation', headers);
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.data.dryRun, true);
      assert.equal(body.data.clean, true);
    }
  });

  it('accepts a grace window and validates it', async () => {
    assert.equal((await get('/reconciliation?graceMinutes=30', maintainerAuth())).status, 200);
    assert.equal((await get('/reconciliation?graceMinutes=-1', maintainerAuth())).status, 400);
    assert.equal((await get('/reconciliation?graceMinutes=abc', maintainerAuth())).status, 400);
    assert.equal((await get('/reconciliation?graceMinutes=99999', maintainerAuth())).status, 400);
  });

  it('is GET only: there is no way to apply a repair over HTTP', async () => {
    const response = await fetch(`${baseUrl}/reconciliation`, { method: 'POST', headers: maintainerAuth() });
    assert.equal(response.status, 404);
  });
});
