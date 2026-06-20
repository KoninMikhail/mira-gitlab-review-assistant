/**
 * Core domain types. These are framework- and integration-agnostic: `core`
 * knows nothing about GitLab/Kaiten/Cursor, only about these types and the
 * ports in `../ports`.
 */

export type Severity = 'blocker' | 'major' | 'minor' | 'nit';

/** Overall MR-level verdict. */
export type Verdict = 'ok' | 'risks' | 'blockers';

/** Classification of a finding. */
export type FindingCategory =
  | 'bug'
  | 'security'
  | 'perf'
  | 'requirements'
  | 'maintainability'
  | 'style';

/** Reviewer confidence in a finding. */
export type Confidence = 'high' | 'medium' | 'low';

/** Whether an acceptance criterion is implemented by the changes. */
export type RequirementStatus = 'met' | 'partial' | 'missing' | 'unknown';

/** What caused a review to be enqueued. See docs/04-architecture/triggers.md. */
export type TriggerKind =
  | 'open'
  | 'ready'
  | 'push'
  | 'reopen'
  | 'chatops'
  | 'poll'
  /** Manual / CLI run (PoC, debugging). */
  | 'manual';

/**
 * Identity of a single review target: a specific MR pinned to a specific head
 * SHA. This triple is the idempotency anchor — the same `(project, mr, sha)` is
 * never reviewed twice (see docs/04-architecture/review-pipeline.md §6).
 */
export interface JobKey {
  projectId: string;
  mrIid: number;
  /** Head commit SHA the review is pinned to. */
  headSha: string;
}

/** A normalized unit of work on the queue: a {@link JobKey} plus its origin. */
export interface ReviewJob extends JobKey {
  /** What triggered this job. */
  trigger: TriggerKind;
  /** ISO-8601 timestamp of when the job was enqueued. */
  enqueuedAt: string;
}

/** Reference to a linked task-tracker card (Kaiten). */
export interface TaskCard {
  id: string;
  title: string;
  description: string;
  /** Acceptance criteria normalized to a flat list of strings. */
  acceptanceCriteria: string[];
}

/** A changed file in the MR. */
export interface ChangedFile {
  path: string;
  /** Previous path when renamed. */
  oldPath?: string;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

/** Everything the engine needs to review one MR (or unit of it). */
export interface ReviewContext {
  /** Identity of the MR/SHA under review (trigger metadata is not needed here). */
  job: JobKey;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  changedFiles: ChangedFile[];
  /** Unified diff (target...source), taken from local checkout. */
  diff: string;
  /** Linked task card, when the resolver found one. */
  card?: TaskCard;
}

/** A unit of work after decomposition (a slice of the review). */
export interface ReviewUnit {
  id: string;
  context: ReviewContext;
}

/** A single review finding produced by the engine. */
export interface Finding {
  severity: Severity;
  category: FindingCategory;
  /** Path relative to repo root. */
  filePath: string;
  /** Short, direct statement of the issue. */
  message: string;
  /** 1-based first line the finding refers to. */
  lineStart?: number;
  /** 1-based last line the finding refers to. */
  lineEnd?: number;
  /** Why it matters. */
  rationale?: string;
  /** Concrete fix suggestion, when available. */
  suggestion?: string;
  confidence?: Confidence;
}

/** Per-criterion assessment of the linked task's acceptance criteria. */
export interface RequirementCoverage {
  criterion: string;
  status: RequirementStatus;
  /** Optional reference (file/line/reasoning) backing the status. */
  evidence?: string;
}

/** Result of a review run. */
export interface ReviewResult {
  /** Overall MR-level verdict. */
  verdict: Verdict;
  /** Free-form summary suitable for the MR overview comment. */
  summary: string;
  findings: Finding[];
  /** Per-criterion coverage of the linked task's acceptance criteria. */
  requirementsCoverage?: RequirementCoverage[];
  /** Notes about missing context / skipped analysis. */
  degradations?: string[];
}
