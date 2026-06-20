/**
 * Merge partial {@link ReviewResult}s from review units into one MR-level result.
 * See docs/04-architecture/decomposition-context-budget.md §4.
 */
import type {
  Finding,
  RequirementCoverage,
  RequirementStatus,
  ReviewResult,
  Severity,
  Verdict,
} from '../domain/index.ts';

export interface AggregateOptions {
  /** Partial results, one per reviewed unit (stable caller order). */
  results: ReviewResult[];
  /** Unit ids that were skipped entirely (optional degradation note). */
  skippedUnitIds?: string[];
  /** Extra degradation notes (e.g. ignored files, budget overflow). */
  skippedContentNotes?: string[];
}

const VERDICT_RANK: Record<Verdict, number> = {
  blockers: 3,
  risks: 2,
  ok: 1,
};

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

/** Worst status wins: missing > partial > unknown > met. */
const REQUIREMENT_STATUS_RANK: Record<RequirementStatus, number> = {
  missing: 4,
  partial: 3,
  unknown: 2,
  met: 1,
};

function findingSignature(finding: Finding): string {
  return `${finding.category}|${finding.filePath}|${finding.message}`;
}

function compareFindings(left: Finding, right: Finding): number {
  const severityDelta = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const pathDelta = left.filePath.localeCompare(right.filePath);
  if (pathDelta !== 0) {
    return pathDelta;
  }
  const leftLine = left.lineStart ?? 0;
  const rightLine = right.lineStart ?? 0;
  return leftLine - rightLine;
}

function mergeFindings(results: ReviewResult[]): Finding[] {
  const seen = new Set<string>();
  const merged: Finding[] = [];

  for (const result of results) {
    for (const finding of result.findings) {
      const signature = findingSignature(finding);
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      merged.push(finding);
    }
  }

  merged.sort(compareFindings);
  return merged;
}

function mergeRequirementCoverage(results: ReviewResult[]): RequirementCoverage[] {
  const byCriterion = new Map<string, RequirementCoverage>();

  for (const result of results) {
    if (result.requirementsCoverage === undefined) {
      continue;
    }
    for (const entry of result.requirementsCoverage) {
      const existing = byCriterion.get(entry.criterion);
      if (existing === undefined) {
        byCriterion.set(entry.criterion, { ...entry });
        continue;
      }
      const existingRank = REQUIREMENT_STATUS_RANK[existing.status];
      const incomingRank = REQUIREMENT_STATUS_RANK[entry.status];
      if (incomingRank > existingRank) {
        byCriterion.set(entry.criterion, { ...entry });
      }
    }
  }

  return [...byCriterion.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, coverage]) => coverage);
}

function worstVerdict(results: ReviewResult[]): Verdict {
  let worst: Verdict = 'ok';
  for (const result of results) {
    if (VERDICT_RANK[result.verdict] > VERDICT_RANK[worst]) {
      worst = result.verdict;
    }
  }
  return worst;
}

function mergeSummaries(results: ReviewResult[]): string {
  const parts = results.map((result) => result.summary.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return '';
  }
  if (parts.length === 1) {
    return parts[0] ?? '';
  }
  return parts.map((part, index) => `[Unit ${index + 1}] ${part}`).join('\n\n');
}

function mergeDegradations(results: ReviewResult[], options: AggregateOptions): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  const push = (note: string): void => {
    const trimmed = note.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    merged.push(trimmed);
  };

  for (const result of results) {
    if (result.degradations === undefined) {
      continue;
    }
    for (const note of result.degradations) {
      push(note);
    }
  }

  if (options.skippedContentNotes !== undefined) {
    for (const note of options.skippedContentNotes) {
      push(note);
    }
  }

  if (options.skippedUnitIds !== undefined && options.skippedUnitIds.length > 0) {
    const ids = [...options.skippedUnitIds].sort((left, right) => left.localeCompare(right));
    push(`Skipped review units: ${ids.join(', ')}`);
  }

  return merged;
}

/** Aggregate unit-level review results into a single MR-level {@link ReviewResult}. */
export function aggregateResults(options: AggregateOptions): ReviewResult {
  const { results } = options;

  if (results.length === 0) {
    const empty: ReviewResult = {
      verdict: 'ok',
      summary: '',
      findings: [],
    };
    const degradations = mergeDegradations([], options);
    if (degradations.length > 0) {
      empty.degradations = degradations;
    }
    return empty;
  }

  const merged: ReviewResult = {
    verdict: worstVerdict(results),
    summary: mergeSummaries(results),
    findings: mergeFindings(results),
  };

  const requirementsCoverage = mergeRequirementCoverage(results);
  if (requirementsCoverage.length > 0) {
    merged.requirementsCoverage = requirementsCoverage;
  }

  const degradations = mergeDegradations(results, options);
  if (degradations.length > 0) {
    merged.degradations = degradations;
  }

  return merged;
}
