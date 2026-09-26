// Standalone worker process: `npm run worker`. Runs the same handlers as the
// embedded worker in server.ts, against the shared PostgreSQL `jobs` table.
import dotenv from 'dotenv';
import { pool } from './config/database';
import invoiceService from './services/invoice.service';
import { JobQueue, JobWorker } from './jobs/worker';
import { PostgresJobStore } from './jobs/postgres-job-store';
import { registerJobHandlers, startExpiryScheduler, startRetentionScheduler } from './jobs/runtime';
import { RetentionService } from './retention/retention-service';
import { PostgresRetentionStore } from './retention/postgres-retention-store';

dotenv.config();

const store = new PostgresJobStore(pool);
// Retention sweep (issue #61), report-only unless a job payload sets apply:true.
const worker = registerJobHandlers(new JobWorker({ store }), {
  expirePendingInvoices: () => invoiceService.markExpiredInvoices(),
  retention: new RetentionService(new PostgresRetentionStore(pool)),
});
const jobQueue = new JobQueue(store);
const stopScheduler = startExpiryScheduler(jobQueue);
const stopRetention = startRetentionScheduler(jobQueue);

worker.start();
console.log('[jobs] standalone worker started');

async function shutdown() {
  worker.stop();
  stopScheduler();
  stopRetention();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
