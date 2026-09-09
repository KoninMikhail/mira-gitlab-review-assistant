/**
 * Deterministic MR decomposition for mode `single`: one task-scope per MR, split
 * only by diff byte budget at file boundaries. See docs/04-architecture/decomposition-context-budget.md §3.
 */
import type { ChangedFile, ReviewContext, ReviewUnit } from '../domain/index.ts';
import type { ContextBudget, ContextBudgetEstimate } from '../policy/types.ts';
import { matchesAny } from './glob.ts';

export interface PartitionOptions {
  ignoredGlobs: string[];
  contextBudget: ContextBudget;
}

interface FileDiffSection {
  path: string;
  content: string;
}

/** Estimate diff payload size for budgeting (bytes or rough tokens). */
export function estimateContentSize(content: string, estimate: ContextBudgetEstimate): number {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (estimate === 'bytes') {
    return byteLength;
  }
  return Math.ceil(byteLength / 4);
}

/**
 * Split a unified diff into whole-file sections keyed by the post-image (`b/`) path.
 * Sections never cross `diff --git` markers.
 */
export function parseDiffSections(diff: string): FileDiffSection[] {
  const trimmed = diff.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const sections: FileDiffSection[] = [];
  const lines = diff.split('\n');
  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentPath === undefined) {
      return;
    }
    sections.push({
      path: currentPath,
      content: currentLines.join('\n'),
    });
    currentPath = undefined;
    currentLines = [];
  };

  for (const line of lines) {
    const marker = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (marker !== null) {
      flush();
      currentPath = marker[2];
      currentLines = [line];
      continue;
    }
    if (currentPath !== undefined) {
      currentLines.push(line);
    }
  }

  flush();
  return sections;
}

function filterChangedFiles(files: ChangedFile[], ignoredGlobs: string[]): ChangedFile[] {
  return files.filter((file) => {
    if (file.isBinary) {
      return false;
    }
    return !matchesAny(file.path, ignoredGlobs);
  });
}

function buildUnitContext(
  parent: ReviewContext,
  diff: string,
  files: ChangedFile[],
): ReviewContext {
  const context: ReviewContext = {
    job: parent.job,
    title: parent.title,
    description: parent.description,
    sourceBranch: parent.sourceBranch,
    targetBranch: parent.targetBranch,
    changedFiles: files,
    diff,
  };
  if (parent.card !== undefined) {
    context.card = parent.card;
  }
  if (parent.ci !== undefined) {
    context.ci = parent.ci;
  }
  return context;
}

/**
 * Partition a review context into byte-budgeted units.
 *
 * Empty or whitespace-only diffs yield **zero** units (nothing to review).
 * All files ignored or binary-only → zero units.
 */
export function partitionReview(context: ReviewContext, options: PartitionOptions): ReviewUnit[] {
  const eligibleFiles = filterChangedFiles(context.changedFiles, options.ignoredGlobs);
  if (eligibleFiles.length === 0) {
    return [];
  }

  const eligiblePaths = new Set(eligibleFiles.map((file) => file.path));
  const fileByPath = new Map(eligibleFiles.map((file) => [file.path, file]));

  const sections = parseDiffSections(context.diff)
    .filter((section) => eligiblePaths.has(section.path))
    .sort((left, right) => left.path.localeCompare(right.path));

  if (sections.length === 0) {
    return [];
  }

  const maxChunk = options.contextBudget.maxChunkTokens;
  const estimate = options.contextBudget.estimate;

  const units: ReviewUnit[] = [];
  let bucketSections: FileDiffSection[] = [];
  let bucketSize = 0;

  const flushBucket = (): void => {
    if (bucketSections.length === 0) {
      return;
    }
    const paths = bucketSections.map((section) => section.path);
    const diff = bucketSections.map((section) => section.content).join('\n');
    const files = paths
      .map((path) => fileByPath.get(path))
      .filter((file): file is ChangedFile => file !== undefined);
    units.push({
      id: `unit-${units.length}`,
      context: buildUnitContext(context, diff, files),
    });
    bucketSections = [];
    bucketSize = 0;
  };

  for (const section of sections) {
    const sectionSize = estimateContentSize(section.content, estimate);

    if (sectionSize > maxChunk) {
      flushBucket();
      units.push({
        id: `unit-${units.length}`,
        context: buildUnitContext(
          context,
          section.content,
          [fileByPath.get(section.path)].filter((file): file is ChangedFile => file !== undefined),
        ),
      });
      continue;
    }

    if (bucketSize > 0 && bucketSize + sectionSize > maxChunk) {
      flushBucket();
    }

    bucketSections.push(section);
    bucketSize += sectionSize;
  }

  flushBucket();
  return units;
}
