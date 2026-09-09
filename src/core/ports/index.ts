/**
 * Ports — the only contract `core` depends on. Adapters in `../../adapters`
 * implement these against concrete systems (GitLab, Kaiten, Cursor, ...).
 */
import type {
  ChangedFile,
  JobKey,
  ReviewContext,
  ReviewJob,
  ReviewResult,
  TaskCard,
} from '../domain/index.ts';

/** Read-side access to a VCS (GitLab today). */
export interface VcsReader {
  getMrContext(projectId: string, mrIid: number): Promise<MrContext>;
}

/** One CI job as Mira sees it (VCS-agnostic; GitLab `when`/`allow_failure` mapped here). */
export interface CiJob {
  /** VCS job id; used to fetch traces for failed required jobs. */
  id: number;
  name: string;
  status: string;
  /** Scheduler: `on_success`, `manual`, `always`, … */
  when: string;
  allowFailure: boolean;
}

/** Snapshot for the pre-review presence comment (CI wait + task-link nudge). */
export interface PresenceSnapshot {
  /** MR description; used to detect a missing task-tracker link. */
  description: string;
  /** Jobs of the newest pipeline for the requested SHA. Empty if none exist yet. */
  jobs: CiJob[];
}

/**
 * Read CI/pipeline state for an MR SHA. Mira is not a CI job (ADR 012) — this
 * port only *reads* status (and failed-job traces) so the orchestrator can wait
 * on required jobs and pass CI as extra review evidence.
 */
export interface VcsCiReader {
  getPresenceSnapshot(projectId: string, mrIid: number, sha: string): Promise<PresenceSnapshot>;
  /** Raw job log; core truncates. Empty string when the VCS has no trace. */
  getJobTrace(projectId: string, jobId: number): Promise<string>;
}

/** Minimal MR metadata + changed files (diff is taken from local checkout). */
export interface MrContext {
  projectId: string;
  mrIid: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  changedFiles: ChangedFile[];
}

/** A note (comment) on a merge request. */
export interface MrNote {
  id: number;
  body: string;
  /** Author username, when known. */
  author?: string;
  /** GitLab system notes (state changes etc.); never authored by the bot. */
  system: boolean;
}

/** A discussion thread on a merge request (one or more notes). */
export interface MrDiscussion {
  id: string;
  notes: MrNote[];
  /** True when the discussion is resolvable and currently resolved. */
  resolved: boolean;
  /** True for a standalone note rather than a resolvable thread. */
  individualNote: boolean;
}

/**
 * Position of an inline (diff-anchored) discussion. Mirrors the GitLab REST
 * `position` object (docs/03-reference/integrations-api.md §3). At least one of
 * `newLine`/`oldLine` must be set.
 */
export interface InlinePosition {
  baseSha: string;
  startSha: string;
  headSha: string;
  newPath: string;
  oldPath?: string;
  newLine?: number;
  oldLine?: number;
}

/**
 * Write-side access to a VCS (phase 2). Low-level note/discussion primitives
 * under the bot account; idempotent publication policy lives in the
 * `GitLabPublisher`, not here. Kaiten write-back stays out of scope (read-only
 * personal token — see .cursor/rules/kaiten-read-only.mdc).
 */
export interface VcsWriter {
  /** List all notes on the MR (used for marker-based idempotency). */
  listNotes(projectId: string, mrIid: number): Promise<MrNote[]>;
  /** Create a general (non-diff) note on the MR. */
  createNote(projectId: string, mrIid: number, body: string): Promise<MrNote>;
  /** Edit an existing note (e.g. refresh the single summary comment). */
  updateNote(projectId: string, mrIid: number, noteId: number, body: string): Promise<MrNote>;
  /** List all discussions on the MR. */
  listDiscussions(projectId: string, mrIid: number): Promise<MrDiscussion[]>;
  /** Create a discussion; inline when `position` is given, otherwise general. */
  createDiscussion(
    projectId: string,
    mrIid: number,
    body: string,
    position?: InlinePosition,
  ): Promise<MrDiscussion>;
  /** Resolve or unresolve a resolvable discussion thread. */
  resolveDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<void>;
}

/**
 * Per-MR mute list for findings silenced via `@mira ignore <fingerprint>`
 * (docs/04-architecture/review-pipeline.md §6). Keyed by `(project, mr)` only — an ignore
 * persists across head SHAs, not just one review.
 */
export interface IgnoreStore {
  /** Add a finding fingerprint to the MR's ignore list (idempotent). */
  ignore(projectId: string, mrIid: number, fingerprint: string): Promise<void>;
  /** Fingerprints currently ignored for the MR. */
  ignored(projectId: string, mrIid: number): Promise<Set<string>>;
}

/** Minimal open-MR metadata for polling triggers (docs/04-architecture/triggers.md variant B). */
export interface MrSummary {
  projectId: string;
  mrIid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  isDraft: boolean;
  state: 'opened' | 'closed' | 'merged' | 'locked';
}

/** Lists open merge requests for pilot discovery (poller; no webhooks). */
export interface VcsMrLister {
  listOpenMergeRequests(projectId: string): Promise<MrSummary[]>;
}

/** Task tracker (Kaiten today). */
export interface TaskTracker {
  getCard(cardId: string): Promise<TaskCard>;
}

/** Review engine (cursor-agent CLI today; SDK/cloud later). */
export interface ReviewEngine {
  review(context: ReviewContext): Promise<ReviewResult>;
}

/** What the {@link Publisher} needs to emit a review: the target + the result. */
export interface PublishInput {
  job: JobKey;
  result: ReviewResult;
}

/**
 * Publishes a finished review. The MVP `LogPublisher` is dry-run (structured
 * log only — it never writes to GitLab or Kaiten). Idempotent MR/comment
 * publishing arrives in phase 2; Kaiten write-back is gated on a bot service
 * account (phase 3+), never the personal read-only token.
 */
export interface Publisher {
  publish(input: PublishInput): Promise<void>;
}

/**
 * Job buffer between triggers (poller/webhook) and the worker. Implementations
 * dedup by {@link JobKey} so the same `(project, mr, sha)` is not processed
 * twice while pending (docs/04-architecture/review-pipeline.md §2.2). In-process for the MVP,
 * Redis-backed later — `core` only knows this interface.
 */
export interface Queue {
  /**
   * Add a job to the queue. Returns `false` if an identical job (same
   * {@link JobKey}) is already pending and was therefore deduplicated.
   */
  enqueue(job: ReviewJob): Promise<boolean>;
  /** Remove and return the next pending job (FIFO), or `undefined` if empty. */
  dequeue(): Promise<ReviewJob | undefined>;
  /** Number of jobs currently pending. */
  size(): Promise<number>;
}

/**
 * Identifies one review run for idempotency. Beyond the MR/SHA it also pins the
 * behavior versions, so bumping the prompt or partitioning re-reviews the same
 * SHA (docs/04-architecture/review-pipeline.md §6, §8).
 */
export interface ReviewKey extends JobKey {
  /** Version of the prompt template used (e.g. `review.v1`). */
  promptVersion: string;
  /** Version of the decomposition/partition logic. */
  partitionVersion: string;
}

/**
 * Durable record of processed reviews and their results. SQLite for the MVP,
 * Postgres later (docs/04-architecture/overview.md §2.7). Guarantees that re-running on
 * an already-reviewed SHA is detected as "already done".
 */
export interface StateStore {
  /** True if a review for this exact key has already been recorded. */
  seen(key: ReviewKey): Promise<boolean>;
  /** Persist a completed review; marks {@link seen} for this key from now on. */
  record(key: ReviewKey, result: ReviewResult): Promise<void>;
}

/**
 * Wall-clock access behind a port, so time-dependent logic (enqueue timestamps,
 * TTL/GC, metrics) stays deterministic in tests.
 */
export interface Clock {
  now(): Date;
}
