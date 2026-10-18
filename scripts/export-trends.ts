/**
 * CLI Command for Exporting Historical Operational and Financial Trends.
 *
 * Usage:
 *   npm run export:trends -- [--granularity day|hour|week|month] [--format json|csv] [--from ISO] [--to ISO]
 */

import {
  generateHistoricalTrendExport,
  type TrendWindowGranularity,
} from '../backend/src/exports/trend-export';
import { getSimulationFixture } from '../backend/src/domain/policy-simulation';

function parseArgs(argv: string[]) {
  let granularity: TrendWindowGranularity = 'day';
  let format: 'json' | 'csv' = 'json';
  let from: string | undefined;
  let to: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--granularity' && argv[i + 1]) {
      granularity = argv[++i] as TrendWindowGranularity;
    } else if (arg === '--format' && argv[i + 1]) {
      format = argv[++i] as 'json' | 'csv';
    } else if (arg === '--from' && argv[i + 1]) {
      from = argv[++i];
    } else if (arg === '--to' && argv[i + 1]) {
      to = argv[++i];
    }
  }

  return { granularity, format, from, to };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date('2026-10-18T12:00:00.000Z');
  const fixture = getSimulationFixture('standard', now);

  const artifact = generateHistoricalTrendExport(
    {
      actor: { id: 'cli-maintainer', role: 'maintainer' },
      granularity: opts.granularity,
      format: opts.format,
      from: opts.from,
      to: opts.to,
      dimensions: ['asset', 'status', 'sellerCohort'],
    },
    {
      invoices: fixture.invoices,
      jobs: fixture.workflows,
      operations: [
        {
          timestamp: new Date(now.getTime() - 3600_000).toISOString(),
          level: 'info',
          operation: 'invoice.create',
          actor_type: 'seller',
          result: 'success',
          latency_ms: 42,
          correlation_id: 'corr-cli-1',
        },
        {
          timestamp: new Date(now.getTime() - 1800_000).toISOString(),
          level: 'warn',
          operation: 'payment.verify',
          actor_type: 'payer',
          result: 'failure',
          latency_ms: 3100,
          correlation_id: 'corr-cli-2',
          error_code: 'HORIZON_UNAVAILABLE',
        },
      ],
    },
    now
  );

  process.stdout.write(artifact.body + '\n');
}

main();
