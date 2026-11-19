import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FileRepairCheckpointStore,
  UnauthorizedRepairApplyError,
  formatDryRunRepairReport,
  runDryRunRepairTool,
} from '../src/ops/dry-run-repair-tool';
import type { RepairDatabase, RepairPhase } from '../src/ops/resumable-repair.service';

class ToolMockDb implements RepairDatabase {
  public updateCalls: string[] = [];
  public failOnPhase: RepairPhase | null = null;
  public transactions = [
    { id: 'tx-1', invoice_id: null as string | null, tx_hash: 'h1', memo: 'QT-1', amount: 10 },
    { id: 'tx-2', invoice_id: null as string | null, tx_hash: 'h2', memo: 'QT-2', amount: 20 },
  ];
  public invoices = [
    { id: 'inv-1', memo: 'QT-1', status: 'PENDING', paid_at: null, payment_tx_hash: null, version: 1 },
    { id: 'inv-2', memo: 'QT-2', status: 'PENDING', paid_at: null, payment_tx_hash: null, version: 1 },
  ];

  async query(text: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    if (text.includes('UPDATE ') || text.includes('DELETE ')) {
      this.updateCalls.push(text);
      return { rows: [] };
    }
    if (text.includes('FROM transactions t') && text.includes('JOIN invoices i ON i.memo = t.memo')) {
      if (this.failOnPhase === 'detached_transactions') {
        throw new Error('Transient DB scan error during detached_transactions');
      }
      const cursor = params[0] ? String(params[0]) : null;
      const limit = Number(params[1] ?? 100);
      const rows = this.transactions
        .filter((t) => !t.invoice_id && (!cursor || t.id > cursor))
        .map((t) => {
          const inv = this.invoices.find((i) => i.memo === t.memo);
          return inv ? { ...t, matching_invoice_id: inv.id } : null;
        })
        .filter(Boolean)
        .slice(0, limit);
      return { rows };
    }
    if (text.includes('LEFT JOIN invoices i ON i.id = t.invoice_id') && this.failOnPhase === 'orphaned_transactions') {
      throw new Error('Transient DB scan error during orphaned_transactions');
    }
    return { rows: [] };
  }
}

describe('Dry-run repair tooling with checkpoints (#366)', () => {
  it('runs in dry-run mode by default, persists checkpoint to disk, and performs zero DB mutations', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inqutum-repair-'));
    try {
      const db = new ToolMockDb();
      const report = await runDryRunRepairTool({
        db,
        checkpointDir: tmpDir,
        phases: ['detached_transactions'],
      });

      assert.equal(report.dryRun, true);
      assert.equal(report.status, 'completed');
      assert.equal(report.counts.scanned, 2);
      assert.equal(report.counts.repaired, 2);
      assert.equal(db.updateCalls.length, 0, 'dry-run must execute zero UPDATE/DELETE queries');

      const store = new FileRepairCheckpointStore(tmpDir);
      const saved = await store.get(report.jobId);
      assert.ok(saved);
      assert.equal(saved.status, 'completed');
      assert.equal(saved.dryRun, true);

      const formatted = formatDryRunRepairReport(report);
      assert.match(formatted, /DRY-RUN \(no mutations\)/);
      assert.match(formatted, /planned\/repaired=2/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists failed checkpoint on scan error and recovers on retry without duplicating actions', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inqutum-repair-retry-'));
    try {
      const db = new ToolMockDb();
      // First run pauses after batch 1 (tx-1)
      const paused = await runDryRunRepairTool({
        db,
        checkpointDir: tmpDir,
        batchSize: 1,
        maxBatches: 1,
        phases: ['detached_transactions', 'orphaned_transactions'],
      });
      assert.equal(paused.status, 'paused');
      assert.equal(paused.cursor, 'tx-1');
      assert.equal(paused.counts.repaired, 1);

      // Next resume hits a transient DB error on orphaned_transactions and persists failed checkpoint
      db.failOnPhase = 'orphaned_transactions';
      await assert.rejects(
        () =>
          runDryRunRepairTool({
            db,
            checkpointDir: tmpDir,
            resumeJobId: paused.jobId,
            batchSize: 1,
          }),
        /Transient DB scan error during orphaned_transactions/
      );
      const store = new FileRepairCheckpointStore(tmpDir);
      const failed = await store.get(paused.jobId);
      assert.ok(failed);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.phase, 'orphaned_transactions');
      assert.equal(failed.repairedCount, 2);
      assert.equal(failed.errors.length, 1);

      // Retry after DB recovers: completes without duplicating detached_transactions
      db.failOnPhase = null;
      const recovered = await runDryRunRepairTool({
        db,
        checkpointDir: tmpDir,
        resumeJobId: paused.jobId,
        batchSize: 1,
      });
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.counts.repaired, 2);
      assert.equal(db.updateCalls.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects live apply without an authorized actor and allows authorized maintainer apply', async () => {
    const db = new ToolMockDb();
    await assert.rejects(
      () =>
        runDryRunRepairTool({
          db,
          apply: true,
          actor: { role: 'viewer', authorized: false },
          phases: ['detached_transactions'],
        }),
      (err: unknown) =>
        err instanceof UnauthorizedRepairApplyError && err.code === 'UNAUTHORIZED_REPAIR_APPLY'
    );
    assert.equal(db.updateCalls.length, 0);

    const applied = await runDryRunRepairTool({
      db,
      apply: true,
      actor: { role: 'maintainer' },
      phases: ['detached_transactions'],
    });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.status, 'completed');
    assert.equal(db.updateCalls.length, 2);
  });
});
