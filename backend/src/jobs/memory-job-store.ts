import { Job, JobError, JobFilter, JobStatus, JobStore } from './job-types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** In-memory JobStore for the MVP server, local development and tests. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private byIdempotencyKey = new Map<string, string>();

  async enqueue(job: Job): Promise<{ job: Job; created: boolean }> {
    if (job.idempotencyKey) {
      const existingId = this.byIdempotencyKey.get(job.idempotencyKey);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing) return { job: clone(existing), created: false };
      this.byIdempotencyKey.set(job.idempotencyKey, job.id);
    }
    this.jobs.set(job.id, clone(job));
    return { job: clone(job), created: true };
  }

  async claimNext(workerId: string, now: Date, leaseMs: number, types?: string[]): Promise<Job | null> {
    const due = [...this.jobs.values()]
      .filter((j) => {
        if (types && !types.includes(j.type)) return false;
        if (j.status === 'queued') return new Date(j.runAt) <= now;
        return j.status === 'running' && !!j.lockedUntil && new Date(j.lockedUntil) <= now;
      })
      .sort((a, b) => a.runAt.localeCompare(b.runAt) || a.createdAt.localeCompare(b.createdAt));

    const job = due[0];
    if (!job) return null;

    job.status = 'running';
    job.attempts += 1;
    job.lockedBy = workerId;
    job.lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
    job.updatedAt = now.toISOString();
    return clone(job);
  }

  async markSucceeded(id: string, workerId: string, result: unknown, now: Date): Promise<Job | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || job.lockedBy !== workerId) return null;
    job.status = 'succeeded';
    job.result = result === undefined ? null : clone(result);
    job.lockedBy = null;
    job.lockedUntil = null;
    job.completedAt = job.updatedAt = now.toISOString();
    return clone(job);
  }

  async markFailed(id: string, workerId: string, error: JobError, retryAt: Date | null, now: Date): Promise<Job | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || job.lockedBy !== workerId) return null;
    job.errors.push(error);
    job.lockedBy = null;
    job.lockedUntil = null;
    job.updatedAt = now.toISOString();
    if (retryAt) {
      job.status = 'queued';
      job.runAt = retryAt.toISOString();
    } else {
      job.status = 'dead';
      job.completedAt = now.toISOString();
    }
    return clone(job);
  }

  async get(id: string): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  async list(filter: JobFilter = {}): Promise<{ jobs: Job[]; total: number }> {
    const matching = [...this.jobs.values()]
      .filter((j) => (!filter.status || j.status === filter.status) && (!filter.type || j.type === filter.type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { jobs: matching.slice(offset, offset + limit).map(clone), total: matching.length };
  }

  async requeueDead(id: string, now: Date): Promise<Job | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'dead') return null;
    job.status = 'queued';
    job.attempts = 0;
    job.runAt = now.toISOString();
    job.completedAt = null;
    job.updatedAt = now.toISOString();
    return clone(job);
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, dead: 0 };
    for (const job of this.jobs.values()) counts[job.status] += 1;
    return counts;
  }

  clear(): void {
    this.jobs.clear();
    this.byIdempotencyKey.clear();
  }
}
