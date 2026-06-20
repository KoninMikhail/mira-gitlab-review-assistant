/**
 * In-process FIFO job queue with {@link JobKey} dedup while pending. Blocks
 * consumers via {@link InProcQueue.take} until a job arrives or the queue is
 * closed; suitable for a single-node MVP worker (docs/04-architecture/review-pipeline.md §2.2).
 */
import type { Queue } from '../../../core/ports/index.ts';
import type { JobKey, ReviewJob } from '../../../core/domain/index.ts';

function jobKeyOf(key: JobKey): string {
  return `${key.projectId}\u0000${String(key.mrIid)}\u0000${key.headSha}`;
}

type TakeWaiter = {
  resolve: (job: ReviewJob | undefined) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
};

/** FIFO in-process queue implementing {@link Queue} plus blocking {@link take}. */
export class InProcQueue implements Queue {
  private readonly jobs: ReviewJob[] = [];
  private readonly pending = new Set<string>();
  private readonly waiters: TakeWaiter[] = [];
  private closed = false;

  enqueue(job: ReviewJob): Promise<boolean> {
    const key = jobKeyOf(job);
    if (this.pending.has(key) || this.closed) {
      return Promise.resolve(false);
    }

    this.pending.add(key);

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      this.deliverToWaiter(waiter, job);
      return Promise.resolve(true);
    }

    this.jobs.push(job);
    return Promise.resolve(true);
  }

  dequeue(): Promise<ReviewJob | undefined> {
    const job = this.jobs.shift();
    if (job !== undefined) {
      this.pending.delete(jobKeyOf(job));
    }
    return Promise.resolve(job);
  }

  size(): Promise<number> {
    return Promise.resolve(this.jobs.length);
  }

  /**
   * Remove and return the next job, waiting until one is available. Resolves
   * `undefined` when the queue is closed and drained, or when `signal` aborts.
   */
  take(signal?: AbortSignal): Promise<ReviewJob | undefined> {
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }

    const job = this.jobs.shift();
    if (job !== undefined) {
      this.pending.delete(jobKeyOf(job));
      return Promise.resolve(job);
    }

    if (this.closed) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const waiter: TakeWaiter = {
        resolve,
        signal,
        onAbort: undefined,
      };

      if (signal !== undefined) {
        const onAbort = (): void => {
          this.removeWaiter(waiter);
          resolve(undefined);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  /** Stop accepting new jobs; {@link take} resolves `undefined` once drained. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      this.cleanupWaiter(waiter);
      waiter.resolve(undefined);
    }
  }

  private deliverToWaiter(waiter: TakeWaiter, job: ReviewJob): void {
    this.cleanupWaiter(waiter);
    this.pending.delete(jobKeyOf(job));
    waiter.resolve(job);
  }

  private removeWaiter(waiter: TakeWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
    this.cleanupWaiter(waiter);
  }

  private cleanupWaiter(waiter: TakeWaiter): void {
    if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}
