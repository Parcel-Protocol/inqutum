/**
 * Dry-Run Repair Tooling with Persistent Checkpoints (#366).
 *
 * Wraps `ResumableRepairService` with:
 *  - Safe-by-default `dryRun: true` execution (preview-only, zero DB mutations).
 *  - Explicit authorization guard before allowing live mutations (`apply: true`).
 *  - `FileRepairCheckpointStore` for durable, atomic checkpoint persistence on disk
 *    so interrupted or failed dry-run scans can be inspected and resumed/retried.
 *  - Human-readable dry-run report formatting (`formatDryRunRepairReport`).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ResumableRepairService,
  type RepairCheckpoint,
  type RepairCheckpointStore,
  type RepairDatabase,
  type RepairExecutionReport,
  type RepairJobStatus,
  type RepairPhase,
} from './resumable-repair.service';

export interface RepairToolActor {
  id?: string;
  role?: string;
  authorized?: boolean;
}

export class UnauthorizedRepairApplyError extends Error {
  readonly code = 'UNAUTHORIZED_REPAIR_APPLY';

  constructor(message = 'Live repair apply requires an authorized admin or maintainer actor') {
    super(message);
    this.name = 'UnauthorizedRepairApplyError';
  }
}

const AUTHORIZED_APPLY_ROLES = new Set(['admin', 'maintainer', 'ops']);

/**
 * File-backed `RepairCheckpointStore` that writes each checkpoint atomically
 * (`<jobId>.json.tmp` -> `<jobId>.json`) so dry-run progress survives crashes.
 */
export class FileRepairCheckpointStore implements RepairCheckpointStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(jobId: string): string {
    const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safeId}.json`);
  }

  async get(jobId: string): Promise<RepairCheckpoint | null> {
    const target = this.filePath(jobId);
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, 'utf8');
    return JSON.parse(raw) as RepairCheckpoint;
  }

  async save(checkpoint: RepairCheckpoint): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.filePath(checkpoint.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  }

  async list(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]> {
    if (!fs.existsSync(this.dir)) return [];
    const entries = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    let list = entries.map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as RepairCheckpoint);
    if (options?.status) {
      list = list.filter((cp) => cp.status === options.status);
    }
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (options?.limit) {
      list = list.slice(0, options.limit);
    }
    return list;
  }
}

export interface DryRunRepairToolOptions {
  db: RepairDatabase;
  checkpointStore?: RepairCheckpointStore;
  checkpointDir?: string;
  /** Defaults to false (dry-run preview). Must be authorized when true. */
  apply?: boolean;
  actor?: RepairToolActor;
  resumeJobId?: string;
  batchSize?: number;
  maxBatches?: number;
  phases?: RepairPhase[];
}

export async function runDryRunRepairTool(options: DryRunRepairToolOptions): Promise<RepairExecutionReport> {
  const apply = Boolean(options.apply);
  if (apply) {
    const actor = options.actor;
    const isAuthorized = Boolean(
      actor && (actor.authorized === true || (actor.role && AUTHORIZED_APPLY_ROLES.has(actor.role)))
    );
    if (!isAuthorized) {
      throw new UnauthorizedRepairApplyError();
    }
  }

  const checkpointStore =
    options.checkpointStore ??
    (options.checkpointDir ? new FileRepairCheckpointStore(options.checkpointDir) : undefined);

  const service = new ResumableRepairService({
    db: options.db,
    checkpointStore,
    defaultBatchSize: options.batchSize ?? 100,
  });

  if (options.resumeJobId) {
    return service.resumeRepairJob(options.resumeJobId, {
      batchSize: options.batchSize,
      maxBatches: options.maxBatches,
    });
  }

  return service.startRepairJob({
    dryRun: !apply,
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
    phases: options.phases,
  });
}

export function formatDryRunRepairReport(report: RepairExecutionReport): string {
  const lines: string[] = [];
  lines.push(`Repair Job: ${report.jobId}`);
  lines.push(`Mode: ${report.dryRun ? 'DRY-RUN (no mutations)' : 'LIVE APPLY'}`);
  lines.push(`Status: ${report.status.toUpperCase()} | Phase: ${report.currentPhase} | Cursor: ${report.cursor ?? 'null'}`);
  lines.push(
    `Counts: scanned=${report.counts.scanned}, planned/repaired=${report.counts.repaired}, skipped=${report.counts.skipped}, failed=${report.counts.failed}`
  );
  if (report.errors.length > 0) {
    lines.push(`Errors (${report.errors.length}):`);
    for (const err of report.errors.slice(0, 5)) {
      lines.push(`  - [${err.phase}] ${err.recordId ?? 'scan'}: ${err.error}`);
    }
  }
  if (report.actionLogSample.length > 0) {
    lines.push(`Planned/Executed Actions (${report.actionLogSample.length} shown):`);
    for (const action of report.actionLogSample.slice(0, 10)) {
      lines.push(`  - [${action.phase}] ${action.recordId}: ${action.action}`);
    }
  }
  return lines.join('\n');
}
