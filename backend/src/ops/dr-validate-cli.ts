/**
 * CLI wrapper for disaster-recovery validation (issue #62).
 *
 *   npm run validate:dr              # human-readable report, exit 1 on failure
 *   npm run validate:dr -- --json    # machine-readable, for CI gating
 *   npm run validate:dr -- --only invoices.duplicate_memo
 *
 * Read-only: it opens a normal client and runs only the SELECTs defined in
 * dr-validation.ts. It is safe to point at production during an incident.
 */
import { pool } from '../config/database';
import { formatDRReport, validateDisasterRecovery } from './dr-validation';

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex !== -1 ? args[onlyIndex + 1]?.split(',') : undefined;

  if (onlyIndex !== -1 && !only) {
    console.error('validate:dr --only needs a comma-separated list of invariant ids.');
    process.exit(2);
  }

  const report = await validateDisasterRecovery(pool, { only });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDRReport(report));
  }

  // Non-zero on failure so this can gate a deploy or a restore sign-off.
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error('Disaster-recovery validation could not run:', error);
  process.exit(2);
});
