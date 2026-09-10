/**
 * The review pipeline: turns one {@link ReviewJob} into a published, recorded
 * review. This is the orchestrator brain assembled from the phase-1 building
 * blocks (docs/04-architecture/review-pipeline.md §2.3, docs/04-architecture/review-pipeline.md):
 *
 *   (optional CI classify) → seen? (skip unless chatops/manual) → presence ack →
 *   build context (+ CI) →
 *   partition → review each unit → aggregate → normalize → publish → record
 *   (state) → cleanup workspace
 *
 * It depends only on domain types + ports + pure-core helpers (no adapters), so
 * it is unit-testable with fakes. Logger/metrics are passed as minimal
 * structural interfaces to keep `core` free of the observability adapter.
 */
import type { ReviewContext, ReviewJob, ReviewResult } from '../domain/index.ts';
import type {
  CiJob,
  Clock,
  Publisher,
  ReviewEngine,
  ReviewKey,
  StateStore,
  VcsCiReader,
} from '../ports/index.ts';
import type { ContextBuildResult } from '../context/index.ts';
import type { ProjectPolicy } from '../policy/index.ts';
import { partitionReview } from '../partition/index.ts';
import { aggregateResults } from '../aggregate/index.ts';
import { DEFAULT_MAX_FINDINGS, normalizeFindings } from '../normalize/index.ts';
import {
  classifyUnavailableError,
  pickUnavailableReviewSummary,
  unavailableReviewResult,
  type UnavailableKind,
} from '../unavailable-review.ts';
import {
  CI_GRACE_MS,
  CI_WAIT_TIMEOUT_MS,
  ciContextForKind,
  ciOutcomeMayChange,
  foldCiIntoPromptVersion,
  isExplicitReview,
  loadCiFailures,
  resolvePresenceKind,
  skipsCiWait,
  type PresenceKind,
} from '../ci/index.ts';
import {
  composePresenceSummary,
  presenceAckResult,
  type PresenceAckKind,
} from '../presence/index.ts';

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
  /**
   * Override unavailable-review copy. Tests inject a fixed string; production
   * leaves this unset so {@link pickUnavailableReviewSummary} classifies the
   * engine error (auth / model / network / empty output).
   */
  pickUnavailableSummary?: (kind?: UnavailableKind, detail?: string) => string;
  /** When set, auto-triggers wait on required CI before checkout/engine. */
  ciReader?: VcsCiReader;
  /**
   * Called when the job yields because required CI is still running. The
   * composition root re-enqueues after a delay. Must not mark {@link StateStore.seen}.
   */
  onWaiting?: (job: ReviewJob) => void;
  /**
   * Called when this SHA's CI may still change without a new commit (red or
   * timeout). The composition root unpins the poller `handled` set so a later
   * green pipeline can enqueue a new review.
   */
  onCiMayChange?: (job: ReviewJob) => void;
  /** Override presence copy (tests). */
  pickPresenceSummary?: (kind: PresenceAckKind, description: string) => string;
  ciGraceMs?: number;
  ciWaitTimeoutMs?: number;
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

    const logFields = {
      project_id: job.projectId,
      mr_iid: job.mrIid,
      head_sha: job.headSha,
    };

    const presence = await classifyPresence(deps, job, logFields);
    if (presence.kind === 'wait') {
      await publishPresenceAck(deps, job, presence.kind, presence.description, logFields);
      deps.onWaiting?.(job);
      deps.logger.info('review.ci.wait', logFields);
      return;
    }

    const reviewKey: ReviewKey = {
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: foldCiIntoPromptVersion(promptVersion, presence.kind),
      partitionVersion: deps.partitionVersion,
    };

    if (await deps.store.seen(reviewKey)) {
      if (!isExplicitReview(job.trigger)) {
        if (ciOutcomeMayChange(presence.kind)) {
          deps.onCiMayChange?.(job);
        }
        deps.logger.info('review.skip.seen', {
          ...logFields,
          prompt_version: reviewKey.promptVersion,
        });
        return;
      }
      deps.logger.info('review.rereview', {
        ...logFields,
        prompt_version: reviewKey.promptVersion,
        trigger: job.trigger,
      });
      await publishPresenceAck(deps, job, 'rereview', presence.description, logFields);
    } else if (presence.kind !== undefined) {
      await publishPresenceAck(deps, job, presence.kind, presence.description, logFields);
    }

    deps.hooks?.onReviewStart?.();
    const startedAt = deps.clock.now().getTime();
    const built = await deps.contextBuilder.build(job);

    try {
      const context = await attachCiEvidence(deps, job, built.context, presence);
      const units = partitionReview(context, {
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
        let lastUnitError: string | undefined;

        for (const unit of units) {
          try {
            results.push(await engine.review(unit.context));
          } catch (err: unknown) {
            deps.hooks?.onEngineError?.();
            failedUnitIds.push(unit.id);
            lastUnitError = messageOf(err);
            deps.logger.error('review.unit.error', {
              ...logFields,
              unit: unit.id,
              error: lastUnitError,
            });
          }
        }

        if (results.length === 0 && failedUnitIds.length > 0) {
          const kind = classifyUnavailableError(lastUnitError ?? '');
          const summary = (
            deps.pickUnavailableSummary ??
            ((k, detail) => pickUnavailableReviewSummary(k, Math.random, detail))
          )(kind, lastUnitError);
          result = unavailableReviewResult(summary);
          deps.logger.warn('review.unavailable', {
            ...logFields,
            units: units.length,
            kind,
            error: lastUnitError,
          });
        } else {
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
      }

      await deps.publisher.publish({
        job,
        result,
        cardLinked: context.card !== undefined,
        freshSummary: isExplicitReview(job.trigger),
      });
      await deps.store.record(reviewKey, result);
      if (ciOutcomeMayChange(presence.kind)) {
        deps.onCiMayChange?.(job);
      }

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

type LogFields = { project_id: string; mr_iid: number; head_sha: string };

interface PresenceClassify {
  kind: PresenceKind | undefined;
  description: string;
  jobs: readonly CiJob[];
}

async function classifyPresence(
  deps: ReviewPipelineDeps,
  job: ReviewJob,
  logFields: LogFields,
): Promise<PresenceClassify> {
  if (deps.ciReader === undefined || skipsCiWait(job.trigger)) {
    return { kind: undefined, description: '', jobs: [] };
  }

  try {
    const snapshot = await deps.ciReader.getPresenceSnapshot(job.projectId, job.mrIid, job.headSha);
    const nowMs = deps.clock.now().getTime();
    const parsed = Date.parse(job.enqueuedAt);
    const enqueuedAtMs = Number.isFinite(parsed) ? parsed : nowMs;
    return {
      kind: resolvePresenceKind({
        jobs: snapshot.jobs,
        nowMs,
        enqueuedAtMs,
        graceMs: deps.ciGraceMs ?? CI_GRACE_MS,
        timeoutMs: deps.ciWaitTimeoutMs ?? CI_WAIT_TIMEOUT_MS,
      }),
      description: snapshot.description,
      jobs: snapshot.jobs,
    };
  } catch (err: unknown) {
    deps.logger.warn('review.ci.error', { ...logFields, error: messageOf(err) });
    return { kind: undefined, description: '', jobs: [] };
  }
}

async function publishPresenceAck(
  deps: ReviewPipelineDeps,
  job: ReviewJob,
  kind: PresenceAckKind,
  description: string,
  logFields: LogFields,
): Promise<void> {
  const summary = (deps.pickPresenceSummary ?? composePresenceSummary)(kind, description);
  await deps.publisher.publish({
    job,
    result: presenceAckResult(summary, kind),
    freshSummary: isExplicitReview(job.trigger),
  });
  deps.logger.info('review.presence', { ...logFields, kind });
}

async function attachCiEvidence(
  deps: ReviewPipelineDeps,
  job: ReviewJob,
  context: ReviewContext,
  presence: PresenceClassify,
): Promise<ReviewContext> {
  if (presence.kind === undefined) {
    return context;
  }
  const failures =
    presence.kind === 'red' && deps.ciReader !== undefined
      ? await loadCiFailures(deps.ciReader, job.projectId, presence.jobs)
      : [];
  const ci = ciContextForKind(presence.kind, failures);
  if (ci === undefined) {
    return context;
  }
  return { ...context, ci };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
