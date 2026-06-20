/**
 * Polling trigger (docs/04-architecture/triggers.md variant B): lists open MRs for pilot
 * projects and enqueues reviews for non-draft MRs matching `review_on` policy.
 * Decision logic is pure (`selectJobs`); the loop is thin and fully injectable.
 */
import type { ReviewJob, TriggerKind } from '../../core/domain/index.ts';
import type { MrSummary, VcsMrLister } from '../../core/ports/index.ts';
import type { ProjectPolicy } from '../../core/policy/index.ts';

/** Minimal queue surface the poller needs (matches {@link Queue.enqueue}). */
export interface PollerQueue {
  enqueue(job: ReviewJob): Promise<boolean>;
}

export interface PollOnceOptions {
  lister: VcsMrLister;
  projects: string[];
  queue: PollerQueue;
  policyFor: (projectPath: string) => ProjectPolicy;
  alreadyHandled: (mr: MrSummary) => boolean;
  now: () => Date;
  logger?: { error(msg: string): void };
}

export interface RunPollerOptions extends PollOnceOptions {
  intervalMs: number;
  signal: AbortSignal;
}

/**
 * Select review jobs from a snapshot of open MRs. Skips drafts, MRs already
 * handled for their head SHA, and MRs whose policy disables initial-state
 * triggers (`open` / `ready`). Push/reopen are webhook-only — not inferred here.
 */
export function selectJobs(
  mrs: MrSummary[],
  policyFor: (projectPath: string) => ProjectPolicy,
  alreadyHandled: (mr: MrSummary) => boolean,
  now: () => Date,
): ReviewJob[] {
  const jobs: ReviewJob[] = [];

  for (const mr of mrs) {
    if (mr.isDraft || mr.state !== 'opened') {
      continue;
    }
    if (alreadyHandled(mr)) {
      continue;
    }

    const policy = policyFor(mr.projectId);
    const trigger = pickInitialTrigger(policy.reviewOn);
    if (trigger === undefined) {
      continue;
    }

    jobs.push({
      projectId: mr.projectId,
      mrIid: mr.mrIid,
      headSha: mr.headSha,
      trigger,
      enqueuedAt: now().toISOString(),
    });
  }

  return jobs;
}

function pickInitialTrigger(reviewOn: ProjectPolicy['reviewOn']): TriggerKind | undefined {
  if (reviewOn.open) {
    return 'open';
  }
  if (reviewOn.ready) {
    return 'ready';
  }
  return undefined;
}

/** One poll tick: list MRs per project, select jobs, enqueue. Errors are logged. */
export async function pollOnce(options: PollOnceOptions): Promise<number> {
  const { lister, projects, queue, policyFor, alreadyHandled, now, logger } = options;
  let enqueued = 0;

  for (const projectId of projects) {
    try {
      const mrs = await lister.listOpenMergeRequests(projectId);
      const jobs = selectJobs(mrs, policyFor, alreadyHandled, now);
      for (const job of jobs) {
        const accepted = await queue.enqueue(job);
        if (accepted) {
          enqueued += 1;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error(`poll failed for ${projectId}: ${msg}`);
    }
  }

  return enqueued;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run {@link pollOnce} every `intervalMs` until `signal` aborts. The first tick
 * runs immediately; subsequent ticks wait for the interval.
 */
export async function runPoller(options: RunPollerOptions): Promise<void> {
  const { intervalMs, signal } = options;

  while (!signal.aborted) {
    await pollOnce(options);
    if (signal.aborted) {
      break;
    }
    await sleep(intervalMs, signal);
  }
}
