/**
 * The review pipeline: turns one {@link ReviewJob} into a published, recorded
 * review. This is the orchestrator brain assembled from the phase-1 building
 * blocks (docs/04-architecture/review-pipeline.md §2.3, docs/04-architecture/review-pipeline.md):
 *
 *   seen? → build context → partition → review each unit → aggregate →
 *   normalize → publish → record (state) → cleanup workspace
 *
 * It depends only on domain types + ports + pure-core helpers (no adapters), so
 * it is unit-testable with fakes. Logger/metrics are passed as minimal
 * structural interfaces to keep `core` free of the observability adapter.
 */
import type { ReviewJob, ReviewResult } from '../domain/index.ts';
import type { Clock, Publisher, ReviewEngine, ReviewKey, StateStore } from '../ports/index.ts';
import type { ContextBuildResult } from '../context/index.ts';
import type { ProjectPolicy } from '../policy/index.ts';
import { partitionReview } from '../partition/index.ts';
import { aggregateResults } from '../aggregate/index.ts';
import { DEFAULT_MAX_FINDINGS, normalizeFindings } from '../normalize/index.ts';

/** Structural logger (the observability `Logger` satisfies this). */
export interface PipelineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Optional metric hooks; wired to the registry at the composition root. */
export interface PipelineHooks {
  onReviewStart?(): void;
  onReviewDone?(durationMs: number, unitCount: number): void;
  onEngineError?(): void;
}

export interface ReviewPipelineDeps {
  contextBuilder: { build(job: ReviewJob): Promise<ContextBuildResult> };
  resolvePolicy: (projectId: string) => ProjectPolicy;
  /** Build an engine bound to the MR checkout directory, configured for the policy. */
  createEngine: (workspaceDir: string, policy: ProjectPolicy) => ReviewEngine;
  publisher: Publisher;
  store: StateStore;
  logger: PipelineLogger;
  clock: Clock;
  /** Behavior versions pinned into the idempotency key. */
  promptVersion: string;
  partitionVersion: string;
  /**
   * Optional guidance fingerprint (e.g. `python@a1b2c3d4`) folded into the
   * effective prompt version of the idempotency key. Lets profile/guidance edits
   * trigger a re-review of an otherwise-unchanged SHA. Returns `undefined` when
   * the policy selects no profile.
   */
  resolveGuidanceVersion?: (policy: ProjectPolicy) => string | undefined;
  hooks?: PipelineHooks;
}

/**
 * Create the job handler. The returned function is what the worker loop runs
 * per job; it never throws for normal degradations (engine failures become
 * aggregated degradation notes) but will throw on infrastructural failures
 * (e.g. checkout/store errors) so the worker can log/retry.
 */
export function createReviewPipeline(deps: ReviewPipelineDeps): (job: ReviewJob) => Promise<void> {
  return async function handle(job: ReviewJob): Promise<void> {
    // Resolve policy up front: the selected profile's guidance fingerprint is
    // part of the idempotency key, so it must be known before the `seen` check.
    const policy = deps.resolvePolicy(job.projectId);
    const guidanceVersion = deps.resolveGuidanceVersion?.(policy);
    const promptVersion =
      guidanceVersion !== undefined && guidanceVersion !== ''
        ? `${deps.promptVersion}+${guidanceVersion}`
        : deps.promptVersion;

    const reviewKey: ReviewKey = {
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion,
      partitionVersion: deps.partitionVersion,
    };
    const logFields = {
      project_id: job.projectId,
      mr_iid: job.mrIid,
      head_sha: job.headSha,
    };

    if (await deps.store.seen(reviewKey)) {
      deps.logger.info('review.skip.seen', logFields);
      return;
    }

    deps.hooks?.onReviewStart?.();
    const startedAt = deps.clock.now().getTime();
    const built = await deps.contextBuilder.build(job);

    try {
      const units = partitionReview(built.context, {
        ignoredGlobs: policy.ignoredGlobs,
        contextBudget: policy.contextBudget,
      });

      let result: ReviewResult;
      if (units.length === 0) {
        result = {
          verdict: 'ok',
          summary: 'No reviewable changes (all files ignored or empty diff).',
          findings: [],
        };
        deps.logger.info('review.empty', logFields);
      } else {
        const engine = deps.createEngine(built.workspaceDir, policy);
        const results: ReviewResult[] = [];
        const failedUnitIds: string[] = [];

        for (const unit of units) {
          try {
            results.push(await engine.review(unit.context));
          } catch (err: unknown) {
            deps.hooks?.onEngineError?.();
            failedUnitIds.push(unit.id);
            deps.logger.error('review.unit.error', {
              ...logFields,
              unit: unit.id,
              error: messageOf(err),
            });
          }
        }

        const merged = aggregateResults({ results, skippedUnitIds: failedUnitIds });
        const normalized = normalizeFindings(merged.findings, {
          strictness: policy.strictness,
          ignoredGlobs: policy.ignoredGlobs,
          maxFindings: DEFAULT_MAX_FINDINGS,
        });
        result = { ...merged, findings: normalized.findings.map((n) => n.finding) };
        deps.logger.info('review.normalized', {
          ...logFields,
          units: units.length,
          dropped: normalized.dropped,
        });
      }

      await deps.publisher.publish({ job, result });
      await deps.store.record(reviewKey, result);

      deps.hooks?.onReviewDone?.(deps.clock.now().getTime() - startedAt, units.length);
      deps.logger.info('review.done', {
        ...logFields,
        verdict: result.verdict,
        findings: result.findings.length,
        units: units.length,
      });
    } finally {
      await built.cleanup();
    }
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
