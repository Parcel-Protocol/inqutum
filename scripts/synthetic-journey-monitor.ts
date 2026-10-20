#!/usr/bin/env tsx
/**
 * Synthetic Journey Monitor runner script (Issue #264).
 *
 * Exercises the end-to-end happy path:
 * Invoice creation -> Details inspection -> Payment verification -> Settlement transition -> Proof dispatch.
 *
 * Usage:
 *   npx tsx scripts/synthetic-journey-monitor.ts
 *   npx tsx scripts/synthetic-journey-monitor.ts --json
 *   npx tsx scripts/synthetic-journey-monitor.ts --check --retries 2
 */

import {
  SyntheticJourneyMonitor,
  formatSyntheticJourneyReport,
} from '../backend/src/ops/synthetic-journey-monitor';

async function main() {
  const isJson = process.argv.includes('--json');
  const isCheck = process.argv.includes('--check');
  const retriesIndex = process.argv.indexOf('--retries');
  const retries = retriesIndex >= 0 ? Math.max(0, Number(process.argv[retriesIndex + 1] ?? 0) || 0) : 0;

  let report = await new SyntheticJourneyMonitor().runJourney();
  for (let attempt = 1; !report.success && attempt <= retries; attempt++) {
    report = await new SyntheticJourneyMonitor().runJourney();
  }

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSyntheticJourneyReport(report));
  }

  if (isCheck && !report.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Synthetic journey monitor fatal error:', err);
  process.exit(1);
});
