/**
 * Typed project policy and top-level policy configuration. Mirrors
 * docs/03-reference/policy-config.md §4 and docs/04-architecture/triggers.md (`review_on` rules).
 */

/** How aggressively findings are surfaced (docs/03-reference/policy-config.md §4.1). */
export type Strictness = 'strict' | 'balanced' | 'lenient';

/** How diff size is estimated for context budgeting (docs/04-architecture/decomposition-context-budget.md §3). */
export type ContextBudgetEstimate = 'bytes' | 'tokenizer';

/**
 * Which MR lifecycle events enqueue a review. Maps to docs/04-architecture/triggers.md:
 * `open` = first non-draft open; `ready` = draft→ready; `push` = new commits;
 * `reopen` = MR reopened; `manual` = `@mira review` / CLI.
 */
export interface ReviewOnPolicy {
  open: boolean;
  ready: boolean;
  push: boolean;
  reopen: boolean;
  manual: boolean;
}

/** Per-run diff budget injected into the agent prompt (docs/04-architecture/decomposition-context-budget.md §3). */
export interface ContextBudget {
  maxChunkTokens: number;
  estimate: ContextBudgetEstimate;
}

/** How an MR is split into review units (MVP: single unit only). */
export interface DecompositionPolicy {
  mode: 'single';
}

/** Effective review settings for one GitLab project path. */
export interface ProjectPolicy {
  reviewOn: ReviewOnPolicy;
  strictness: Strictness;
  ignoredGlobs: string[];
  contextBudget: ContextBudget;
  decomposition: DecompositionPolicy;
  model: string;
  /**
   * Optional stack profile name (`python`, `java`, `node`, `frontend`, …). Selects
   * a `profiles/<name>.md` guidance file injected into the reviewer prompt. Unset
   * means "no stack-specific guidance" (general best practices only). The profile
   * id + its content hash are folded into the idempotency key, so editing a profile
   * re-reviews affected MRs. See docs/03-reference/review-profiles.md.
   */
  profile?: string;
}

/** Pilot enrollment: only listed project paths are candidates (docs/03-reference/policy-config.md §4.3 mode B). */
export interface ExplicitDiscovery {
  mode: 'explicit';
  projects: string[];
}

/** Loaded `/etc/mira/config.yml` shape for the MVP (explicit discovery only). */
export interface PolicyConfig {
  defaults: ProjectPolicy;
  projects: Record<string, Partial<ProjectPolicy>>;
  discovery: ExplicitDiscovery;
}
