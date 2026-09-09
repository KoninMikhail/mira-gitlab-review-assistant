/**
 * Classify required CI for an MR SHA. Optional manual jobs (deploy "play"
 * buttons and similar) are ignored — Mira waits only on jobs that run themselves.
 */
import type { TriggerKind } from '../domain/index.ts';
import type { CiJob } from '../ports/index.ts';

/** Still in flight. */
const RUNNING = new Set([
  'created',
  'pending',
  'running',
  'preparing',
  'waiting_for_resource',
  'scheduled',
  'waiting_for_callback',
]);

/** Failed the required path. */
const RED = new Set(['failed', 'canceled']);

/** Finished without blocking. */
const GREEN = new Set(['success', 'skipped']);

/** How long to treat "no pipeline yet" as "still starting" after enqueue. */
export const CI_GRACE_MS = 60_000;

/** How long to wait on required jobs before reviewing anyway. */
export const CI_WAIT_TIMEOUT_MS = 25 * 60 * 1000;

/** Worker re-enqueue delay while waiting (composition root). */
export const CI_RETRY_MS = 30_000;

export type RequiredCiStatus = 'running' | 'green' | 'red' | 'none';

/** Presence lead: wait vs start-after-CI flavors. */
export type PresenceKind = 'wait' | 'green' | 'red' | 'none' | 'timeout';

/** Manual ChatOps/CLI must not sit on CI. */
export function skipsCiWait(trigger: TriggerKind): boolean {
  return trigger === 'manual' || trigger === 'chatops';
}

/**
 * Fold the settled CI outcome into the idempotency prompt version so red→green
 * on the same SHA is a new review (ADR 015). Wait is never recorded.
 */
export function foldCiIntoPromptVersion(
  promptVersion: string,
  kind: PresenceKind | undefined,
): string {
  if (kind === undefined || kind === 'wait') {
    return promptVersion;
  }
  return `${promptVersion}+ci.${kind}`;
}

/** Same SHA may still change CI without a new commit — poller must not pin it. */
export function ciOutcomeMayChange(kind: PresenceKind | undefined): boolean {
  return kind === 'red' || kind === 'timeout';
}

/** `when: manual` — optional play-button jobs, including unfinished ones. */
export function isOptionalManualJob(job: CiJob): boolean {
  return job.when === 'manual';
}

/** Status of jobs that actually gate the review wait. */
export function classifyRequiredCi(jobs: readonly CiJob[]): RequiredCiStatus {
  const required = jobs.filter((job) => !isOptionalManualJob(job));
  if (required.length === 0) {
    return 'none';
  }
  if (required.some((job) => RUNNING.has(job.status) || isUnknownStatus(job.status))) {
    return 'running';
  }
  const blocking = required.filter((job) => !job.allowFailure);
  if (blocking.some((job) => RED.has(job.status))) {
    return 'red';
  }
  return 'green';
}

export interface ResolvePresenceKindInput {
  jobs: readonly CiJob[];
  nowMs: number;
  enqueuedAtMs: number;
  graceMs?: number;
  timeoutMs?: number;
}

/**
 * Map raw CI + job age onto a presence kind. Fresh MRs with no pipeline yet
 * wait out a short grace window; stuck required jobs eventually time out.
 */
export function resolvePresenceKind(input: ResolvePresenceKindInput): PresenceKind {
  const graceMs = input.graceMs ?? CI_GRACE_MS;
  const timeoutMs = input.timeoutMs ?? CI_WAIT_TIMEOUT_MS;
  const age = Math.max(0, input.nowMs - input.enqueuedAtMs);
  const raw = classifyRequiredCi(input.jobs);

  if (raw === 'none' && age < graceMs) {
    return 'wait';
  }
  if (raw === 'running' && age >= timeoutMs) {
    return 'timeout';
  }
  if (raw === 'running') {
    return 'wait';
  }
  if (raw === 'green') {
    return 'green';
  }
  if (raw === 'red') {
    return 'red';
  }
  return 'none';
}

function isUnknownStatus(status: string): boolean {
  return !RUNNING.has(status) && !RED.has(status) && !GREEN.has(status) && status !== 'manual';
}
