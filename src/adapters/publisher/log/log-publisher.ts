/**
 * `LogPublisher` — the phase-1 dry-run `Publisher`. It emits a structured
 * summary of a review (verdict, severity tally, each finding, requirement
 * coverage, degradations) to the observability logger and DOES NOT touch the
 * MR or the Kaiten card.
 *
 * Dry-run is deliberate for the MVP (docs/01-concepts/roadmap.md, phase 1): the bot
 * observes and reports without changing anything. GitLab publishing lands in
 * phase 2; Kaiten write-back is gated on a dedicated bot service account
 * (phase 3+) — never the personal read-only token (see .cursor/rules).
 */
import type { Finding, Severity } from '../../../core/domain/index.ts';
import type { PublishInput, Publisher } from '../../../core/ports/index.ts';
import type { Logger } from '../../../observability/index.ts';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'major', 'minor'];

export interface LogPublisherOptions {
  logger: Logger;
}

export class LogPublisher implements Publisher {
  readonly #logger: Logger;

  constructor(options: LogPublisherOptions) {
    this.#logger = options.logger;
  }

  publish(input: PublishInput): Promise<void> {
    const { job, result } = input;
    const log = this.#logger.child({
      project_id: job.projectId,
      mr_iid: job.mrIid,
      head_sha: job.headSha,
      dry_run: true,
    });

    log.info('review.summary', {
      verdict: result.verdict,
      findings_total: result.findings.length,
      by_severity: countBySeverity(result.findings),
      summary: result.summary,
    });

    for (const finding of orderFindings(result.findings)) {
      log.info('review.finding', toFindingFields(finding));
    }

    if (result.requirementsCoverage !== undefined && result.requirementsCoverage.length > 0) {
      for (const item of result.requirementsCoverage) {
        log.info('review.requirement', {
          status: item.status,
          criterion: item.criterion,
          ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
        });
      }
    }

    if (result.degradations !== undefined && result.degradations.length > 0) {
      log.warn('review.degraded', { degradations: result.degradations });
    }

    return Promise.resolve();
  }
}

/** Tally findings per severity (all buckets present, even at zero). */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Deterministic order for logging: severity rank, then path, then start line. */
function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const byPath = a.filePath.localeCompare(b.filePath);
    if (byPath !== 0) {
      return byPath;
    }
    return (a.lineStart ?? 0) - (b.lineStart ?? 0);
  });
}

function toFindingFields(finding: Finding): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    severity: finding.severity,
    category: finding.category,
    file: finding.filePath,
    message: finding.message,
  };
  if (finding.lineStart !== undefined) fields['line_start'] = finding.lineStart;
  if (finding.lineEnd !== undefined) fields['line_end'] = finding.lineEnd;
  if (finding.suggestion !== undefined) fields['suggestion'] = finding.suggestion;
  if (finding.confidence !== undefined) fields['confidence'] = finding.confidence;
  return fields;
}
