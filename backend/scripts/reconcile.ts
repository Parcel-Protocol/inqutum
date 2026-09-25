#!/usr/bin/env tsx
/**
 * Read-only reconciliation dry run (issue #45). See docs/RECONCILIATION.md.
 *
 * Usage:
 *   npm run reconcile                              # against DATABASE_URL (Postgres)
 *   npm run reconcile -- --input snapshot.json     # against an exported snapshot, no database
 *   npm run reconcile -- --json                    # machine-readable report
 *   npm run reconcile -- --settlements ledger.json # check against an exported ledger file
 *   npm run reconcile -- --fail-on warning         # also fail the run on warnings
 *
 * Exit codes: 0 nothing at or above the threshold, 1 drift found, 2 the run
 * itself could not complete (bad arguments, unreadable input, database error).
 *
 * This script cannot change data. Postgres access uses a dedicated connection
 * opened read-only at the database level and refuses to continue if the server
 * does not confirm it. There is no apply mode.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { reconcile } from '../src/domain/reconciliation';
import type {
  ReconciliationInput,
  ReconciliationReport,
  ReconciliationSettlement,
} from '../src/domain/reconciliation';
import { runReconciliation } from '../src/services/reconciliation.service';
import type { InvoiceStorage } from '../src/storage/invoice-storage';

export type FailOn = 'error' | 'warning' | 'none';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  now?: () => Date;
  /** Opens the storage the run reads from; injectable so tests need no database. */
  openStorage?: (databaseUrl: string) => Promise<{ storage: InvoiceStorage; close(): Promise<void> }>;
}

const USAGE = `Reconciliation dry run (read-only)

  --input <file>         Reconcile an exported snapshot instead of a database
  --settlements <file>   Settlement references to check against (JSON array)
  --stale-grace-minutes  How long past expiry a PENDING invoice may sit (default 5)
  --fail-on <level>      error (default) | warning | none
  --json                 Print the report as JSON
  -h, --help             Show this help

Without --input the run reads DATABASE_URL, read-only.`;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
}

/** Postgres, opened read-only at the session level. Refuses to run unless the server confirms it. */
async function openPostgresReadOnly(databaseUrl: string) {
  const { Client } = await import('pg');
  const { InvoiceService } = await import('../src/services/invoice.service');
  const { PostgresInvoiceStorage } = await import('../src/storage/postgres-invoice-storage');

  const client = new Client({ connectionString: databaseUrl, options: '-c default_transaction_read_only=on' });
  await client.connect();
  const check = await client.query('SHOW default_transaction_read_only');
  if (check.rows[0]?.default_transaction_read_only !== 'on') {
    await client.end();
    throw new Error('Refusing to run: the database session is not read-only');
  }
  return {
    storage: new PostgresInvoiceStorage(new InvoiceService(client)),
    close: () => client.end(),
  };
}

export function formatReport(report: ReconciliationReport): string {
  const lines: string[] = [];
  const { summary, checked, checksRun } = report;

  lines.push(`Reconciliation dry run  ${report.generatedAt}  (read-only, nothing was changed)`);
  lines.push(
    `Checked ${checked.invoices} invoices` +
      `, audit events: ${checked.auditEvents ?? 'not available'}` +
      `, settlement records: ${checked.settlements ?? 'not available'}` +
      `, seller balances: ${checked.revenueSellers ?? 'not available'}`
  );
  const skipped = (Object.entries(checksRun) as Array<[string, boolean]>)
    .filter(([, ran]) => !ran)
    .map(([name]) => name);
  if (skipped.length > 0) {
    lines.push(`NOT verified (no data to check against): ${skipped.join(', ')}`);
  }
  lines.push('');

  if (report.clean) {
    lines.push('No drift found.');
    return lines.join('\n');
  }

  lines.push(
    `${summary.total} finding(s): ` +
      `${summary.byCategory.missing} missing, ${summary.byCategory.duplicate} duplicate, ` +
      `${summary.byCategory.stale} stale, ${summary.byCategory.inconsistent} inconsistent ` +
      `(${summary.bySeverity.error} errors, ${summary.bySeverity.warning} warnings)`
  );
  lines.push('');

  for (const finding of report.findings) {
    const subject = [finding.invoiceId && `invoice ${finding.invoiceId}`, finding.txHash && `tx ${finding.txHash}`]
      .filter(Boolean)
      .join(', ');
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.category}/${finding.code}${subject ? `  (${subject})` : ''}`);
    lines.push(`    ${finding.message}`);
    lines.push(`    Repair: ${finding.repair}`);
  }
  return lines.join('\n');
}

export function exitCodeFor(report: ReconciliationReport, failOn: FailOn): number {
  if (failOn === 'none') return 0;
  const tripped =
    failOn === 'warning' ? report.summary.total > 0 : report.summary.bySeverity.error > 0;
  return tripped ? 1 : 0;
}

/** Testable entry point: no process globals beyond what `io` supplies. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        input: { type: 'string' },
        settlements: { type: 'string' },
        'stale-grace-minutes': { type: 'string' },
        'fail-on': { type: 'string', default: 'error' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error: any) {
    io.err(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    io.out(USAGE);
    return 0;
  }

  const failOn = values['fail-on'] as string;
  if (!['error', 'warning', 'none'].includes(failOn)) {
    io.err(`--fail-on must be error, warning or none\n\n${USAGE}`);
    return 2;
  }

  let staleGraceMs: number | undefined;
  if (values['stale-grace-minutes'] !== undefined) {
    const minutes = Number(values['stale-grace-minutes']);
    if (!Number.isFinite(minutes) || minutes < 0) {
      io.err('--stale-grace-minutes must be a non-negative number');
      return 2;
    }
    staleGraceMs = minutes * 60_000;
  }

  const now = io.now?.() ?? new Date();
  let report: ReconciliationReport;
  let close: (() => Promise<void>) | undefined;

  try {
    const settlementOverride = values.settlements
      ? readJson<ReconciliationSettlement[]>(values.settlements)
      : undefined;

    if (values.input) {
      const snapshot = readJson<Partial<ReconciliationInput>>(values.input);
      if (!Array.isArray(snapshot.invoices)) {
        throw new Error(`${values.input} must contain an "invoices" array`);
      }
      report = reconcile({
        invoices: snapshot.invoices,
        auditEvents: snapshot.auditEvents ?? null,
        settlements: settlementOverride ?? snapshot.settlements ?? null,
        reportedRevenue: snapshot.reportedRevenue ?? null,
        now,
        staleGraceMs,
      });
    } else {
      const databaseUrl = io.env.DATABASE_URL;
      if (!databaseUrl) {
        io.err(`No --input given and DATABASE_URL is not set.\n\n${USAGE}`);
        return 2;
      }
      const opened = await (io.openStorage ?? openPostgresReadOnly)(databaseUrl);
      close = opened.close;
      report = await runReconciliation(opened.storage, {
        now,
        staleGraceMs,
        settlements: settlementOverride,
      });
    }
  } catch (error: any) {
    io.err(`Reconciliation could not run: ${error?.message || error}`);
    return 2;
  } finally {
    await close?.().catch(() => undefined);
  }

  io.out(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return exitCodeFor(report, failOn as FailOn);
}

if (require.main === module) {
  main(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    env: process.env,
  }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(2);
    }
  );
}
