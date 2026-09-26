#!/usr/bin/env tsx
/**
 * Demo Data Retention & Purge Utility (Issue #33, Phase D)
 *
 * Enforces retention bounds on public demo instances by pruning settled,
 * cancelled, or expired invoices older than the retention threshold (default: 24h).
 * Active pending invoices that have not reached their expiry date are strictly preserved.
 */

import dotenv from 'dotenv';
import memoryStorage from '../src/storage/memory-storage';
import postgresStorage from '../src/storage/postgres-invoice-storage';
import { configuredStorageMode } from '../src/config/runtime';

dotenv.config();

export async function runPurge(maxAgeHours = 24): Promise<{ purged: number; mode: string }> {
  const mode = configuredStorageMode();
  console.log(`🧹 Running demo data purge (Retention: ${maxAgeHours} hours, Storage: ${mode})...`);

  let purged = 0;
  if (mode === 'postgres') {
    purged = (await postgresStorage.purgeStaleInvoices?.({ maxAgeHours })) ?? 0;
  } else {
    purged = memoryStorage.purgeStaleInvoices({ maxAgeHours });
  }

  console.log(`✅ Purged ${purged} stale demo invoice(s).`);
  return { purged, mode };
}

if (process.argv[1] && process.argv[1].endsWith('purge-demo-data.ts')) {
  const hoursArg = parseInt(process.argv[2] || process.env.DEMO_RETENTION_HOURS || '24', 10);
  runPurge(hoursArg)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Purge failed:', err);
      process.exit(1);
    });
}
