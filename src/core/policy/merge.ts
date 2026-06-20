/**
 * Deep-merge project policy: global defaults overlaid by per-project overrides
 * from `projects.<path>` (docs/03-reference/policy-config.md §4.1–§4.2).
 */
import type { PolicyConfig, ProjectPolicy } from './types.ts';

function mergeReviewOn(
  base: ProjectPolicy['reviewOn'],
  override: Partial<ProjectPolicy['reviewOn']>,
): ProjectPolicy['reviewOn'] {
  return {
    open: override.open ?? base.open,
    ready: override.ready ?? base.ready,
    push: override.push ?? base.push,
    reopen: override.reopen ?? base.reopen,
    manual: override.manual ?? base.manual,
  };
}

function mergeContextBudget(
  base: ProjectPolicy['contextBudget'],
  override: Partial<ProjectPolicy['contextBudget']>,
): ProjectPolicy['contextBudget'] {
  return {
    maxChunkTokens: override.maxChunkTokens ?? base.maxChunkTokens,
    estimate: override.estimate ?? base.estimate,
  };
}

function mergeDecomposition(
  base: ProjectPolicy['decomposition'],
  override: Partial<ProjectPolicy['decomposition']>,
): ProjectPolicy['decomposition'] {
  return {
    mode: override.mode ?? base.mode,
  };
}

/** Merge `base` with a partial override; nested objects are merged field-wise. */
export function mergeProjectPolicy(
  base: ProjectPolicy,
  override: Partial<ProjectPolicy>,
): ProjectPolicy {
  const merged: ProjectPolicy = {
    reviewOn:
      override.reviewOn !== undefined
        ? mergeReviewOn(base.reviewOn, override.reviewOn)
        : base.reviewOn,
    strictness: override.strictness ?? base.strictness,
    ignoredGlobs: override.ignoredGlobs ?? base.ignoredGlobs,
    contextBudget:
      override.contextBudget !== undefined
        ? mergeContextBudget(base.contextBudget, override.contextBudget)
        : base.contextBudget,
    decomposition:
      override.decomposition !== undefined
        ? mergeDecomposition(base.decomposition, override.decomposition)
        : base.decomposition,
    model: override.model ?? base.model,
  };
  // `profile` is optional under exactOptionalPropertyTypes — set only when present.
  const profile = override.profile ?? base.profile;
  if (profile !== undefined) {
    merged.profile = profile;
  }
  return merged;
}

/** Effective policy for `projectPath` = defaults deep-merged with `projects[path]`. */
export function resolvePolicy(config: PolicyConfig, projectPath: string): ProjectPolicy {
  const override = config.projects[projectPath];
  if (override === undefined) {
    return config.defaults;
  }
  return mergeProjectPolicy(config.defaults, override);
}
