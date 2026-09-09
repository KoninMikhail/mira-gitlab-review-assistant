/**
 * Collect failed required-job evidence for the reviewer. Trace truncation and
 * which jobs count as blocking live in core — the VCS adapter only fetches raw
 * logs.
 */
import type { CiContext, CiFailure, CiReviewStatus } from '../domain/index.ts';
import type { CiJob, VcsCiReader } from '../ports/index.ts';
import type { PresenceKind } from './classify.ts';
import { isOptionalManualJob } from './classify.ts';

/** Failed the required path (same set as classify). */
const RED = new Set(['failed', 'canceled']);

/** Cap how many failed-job logs we inject into the prompt. */
export const CI_FAILURE_JOB_CAP = 3;

/** Last N characters of a job trace (full logs are huge and noisy). */
export const CI_TRACE_MAX_CHARS = 4_000;

export function requiredBlockingFailures(jobs: readonly CiJob[]): CiJob[] {
  return jobs.filter(
    (job) => !isOptionalManualJob(job) && !job.allowFailure && RED.has(job.status),
  );
}

/** Keep the tail of the log; prefer a line boundary when slicing. */
export function excerptTrace(trace: string, maxChars = CI_TRACE_MAX_CHARS): string {
  const normalized = trace.replace(/\r\n/g, '\n').trimEnd();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const tail = normalized.slice(-maxChars);
  const firstNewline = tail.indexOf('\n');
  const sliced = firstNewline >= 0 && firstNewline + 1 < tail.length ? tail.slice(firstNewline + 1) : tail;
  return `…\n${sliced}`;
}

export async function loadCiFailures(
  reader: VcsCiReader,
  projectId: string,
  jobs: readonly CiJob[],
): Promise<CiFailure[]> {
  const failed = requiredBlockingFailures(jobs).slice(0, CI_FAILURE_JOB_CAP);
  const out: CiFailure[] = [];
  for (const job of failed) {
    const item: CiFailure = { jobName: job.name, status: job.status };
    try {
      const excerpt = excerptTrace(await reader.getJobTrace(projectId, job.id));
      if (excerpt !== '') {
        item.excerpt = excerpt;
      }
    } catch {
      // Name + status still help; missing log is not fatal.
    }
    out.push(item);
  }
  return out;
}

export function ciContextForKind(
  kind: PresenceKind,
  failures: readonly CiFailure[],
): CiContext | undefined {
  if (kind === 'wait') {
    return undefined;
  }
  const status: CiReviewStatus = kind;
  return {
    status,
    failures: status === 'red' ? [...failures] : [],
  };
}
