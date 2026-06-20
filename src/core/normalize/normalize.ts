/**
 * Normalize review findings: path filters, strictness thresholds, dedup, and cap.
 * See docs/04-architecture/review-pipeline.md §5–§6.
 */
import type { Finding, Severity } from '../domain/index.ts';
import { findingFingerprint } from '../idempotency/fingerprint.ts';
import { matchesAny } from '../partition/glob.ts';
import type { Strictness } from '../policy/types.ts';

/** Suggested cap when callers derive options from {@link ProjectPolicy}. */
export const DEFAULT_MAX_FINDINGS = 50;

/** A finding with its stable dedup/publication fingerprint. */
export interface NormalizedFinding {
  finding: Finding;
  fingerprint: string;
}

/** Counts of findings removed at each normalization stage (observability). */
export interface NormalizeDropped {
  byGlob: number;
  bySeverity: number;
  byDedup: number;
  byCap: number;
}

export interface NormalizeResult {
  findings: NormalizedFinding[];
  dropped: NormalizeDropped;
}

export interface NormalizeOptions {
  strictness: Strictness;
  ignoredGlobs: string[];
  /** When set, keep at most this many findings (top by severity). Omit for no cap. */
  maxFindings?: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

/**
 * Minimum severity rank kept per strictness (docs/04-architecture/review-pipeline.md §5):
 * - `strict` — all severities (blocker, major, minor, nit)
 * - `balanced` — drop `nit` (keep blocker, major, minor)
 * - `lenient` — only `blocker` and `major`
 */
const MIN_SEVERITY_RANK: Record<Strictness, number> = {
  strict: SEVERITY_RANK['nit'],
  balanced: SEVERITY_RANK['minor'],
  lenient: SEVERITY_RANK['major'],
};

function passesSeverityThreshold(severity: Severity, strictness: Strictness): boolean {
  return SEVERITY_RANK[severity] >= MIN_SEVERITY_RANK[strictness];
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

/**
 * Filter, deduplicate, order, and optionally cap findings for publication.
 * Pure: does not mutate input findings or the domain {@link Finding} type.
 */
export function normalizeFindings(findings: Finding[], options: NormalizeOptions): NormalizeResult {
  const dropped: NormalizeDropped = {
    byGlob: 0,
    bySeverity: 0,
    byDedup: 0,
    byCap: 0,
  };

  const afterFilters: Finding[] = [];

  for (const finding of findings) {
    if (matchesAny(finding.filePath, options.ignoredGlobs)) {
      dropped.byGlob += 1;
      continue;
    }
    if (!passesSeverityThreshold(finding.severity, options.strictness)) {
      dropped.bySeverity += 1;
      continue;
    }
    afterFilters.push(finding);
  }

  const seen = new Set<string>();
  const deduped: NormalizedFinding[] = [];

  for (const finding of afterFilters) {
    const fingerprint = findingFingerprint(finding);
    if (seen.has(fingerprint)) {
      dropped.byDedup += 1;
      continue;
    }
    seen.add(fingerprint);
    deduped.push({ finding, fingerprint });
  }

  deduped.sort((left, right) => compareFindings(left.finding, right.finding));

  if (options.maxFindings !== undefined && deduped.length > options.maxFindings) {
    dropped.byCap = deduped.length - options.maxFindings;
    return {
      findings: deduped.slice(0, options.maxFindings),
      dropped,
    };
  }

  return { findings: deduped, dropped };
}
