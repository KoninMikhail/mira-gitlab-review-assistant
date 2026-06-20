/**
 * Generic bounded-concurrency worker loop. Pulls {@link ReviewJob}s from a
 * {@link JobSource}, invokes an injected handler, and keeps running until the
 * source is drained/closed or the abort signal fires (docs/04-architecture/review-pipeline.md
 * §2.3).
 */
import type { ReviewJob } from '../domain/index.ts';

/** Minimal pull interface for the worker; {@link InProcQueue} implements this. */
export interface JobSource {
  take(signal?: AbortSignal): Promise<ReviewJob | undefined>;
}

export interface RunWorkerOptions {
  queue: JobSource;
  handler: (job: ReviewJob) => Promise<void>;
  concurrency: number;
  signal?: AbortSignal;
  logger?: { error(msg: string): void };
}

/**
 * Process jobs from `queue` with at most `concurrency` handlers in flight.
 * Handler errors are logged and do not stop the loop or other jobs.
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const { queue, handler, concurrency, logger } = options;
  const signal = options.signal;

  const runOne = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        return;
      }

      const job = signal !== undefined ? await queue.take(signal) : await queue.take();
      if (job === undefined) {
        return;
      }

      try {
        await handler(job);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.error(msg);
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => runOne());
  await Promise.all(workers);
}
