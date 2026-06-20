/**
 * `GitLabPublisher` — idempotent phase-2 `Publisher`. Writes one updatable summary
 * note and one discussion per finding (inline when `resolvePosition` yields a
 * diff anchor). Markers in HTML comments survive Markdown rendering and drive
 * dedup across re-runs (docs/05-review-pipeline.md §6).
 */
import type { Finding, JobKey, ReviewResult, Severity } from '../../../core/domain/index.ts';
import { findingFingerprint } from '../../../core/idempotency/fingerprint.ts';
import type {
  IgnoreStore,
  InlinePosition,
  MrDiscussion,
  PublishInput,
  Publisher,
  VcsWriter,
} from '../../../core/ports/index.ts';

/** Hidden marker for the single MR summary note. */
export const SUMMARY_MARKER = '<!-- mira:summary -->';

/** Build the finding fingerprint marker embedded in a discussion body. */
export function findingMarker(fingerprint: string): string {
  return `<!-- mira:finding:${fingerprint} -->`;
}

/** Extract a finding fingerprint from a note/discussion body, if present. */
export const FINDING_MARKER_RE = /<!-- mira:finding:([a-f0-9]+) -->/;

const SEVERITY_ORDER: readonly Severity[] = ['blocker', 'major', 'minor', 'nit'];

const VERDICT_LABEL: Record<ReviewResult['verdict'], string> = {
  ok: 'OK',
  risks: 'Risks',
  blockers: 'Blockers',
};

export interface GitLabPublisherLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface GitLabPublisherOptions {
  writer: VcsWriter;
  ignoreStore?: IgnoreStore;
  logger?: GitLabPublisherLogger;
  resolvePosition?: (job: JobKey, finding: Finding) => InlinePosition | undefined;
}

/** Tally findings per severity (all buckets present, even at zero). */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Extract fingerprint from the first note of a discussion, when marked. */
export function fingerprintFromDiscussion(discussion: MrDiscussion): string | undefined {
  const firstNote = discussion.notes[0];
  if (firstNote === undefined) {
    return undefined;
  }
  const match = FINDING_MARKER_RE.exec(firstNote.body);
  return match?.[1];
}

/** Idempotent GitLab MR publisher backed by {@link VcsWriter}. */
export class GitLabPublisher implements Publisher {
  readonly #writer: VcsWriter;
  readonly #ignoreStore: IgnoreStore | undefined;
  readonly #logger: GitLabPublisherLogger | undefined;
  readonly #resolvePosition: GitLabPublisherOptions['resolvePosition'];

  constructor(options: GitLabPublisherOptions) {
    this.#writer = options.writer;
    this.#ignoreStore = options.ignoreStore;
    this.#logger = options.logger;
    this.#resolvePosition = options.resolvePosition;
  }

  async publish(input: PublishInput): Promise<void> {
    const { job, result } = input;
    const { projectId, mrIid } = job;

    const muted =
      this.#ignoreStore === undefined
        ? new Set<string>()
        : await this.#ignoreStore.ignored(projectId, mrIid);

    const activeFindings = orderFindings(
      result.findings.filter((finding) => !muted.has(findingFingerprint(finding))),
    );
    const activeFingerprints = new Set(activeFindings.map((f) => findingFingerprint(f)));

    const summaryUpdated = await this.#publishSummary(job, result, activeFindings);

    const discussions = await this.#writer.listDiscussions(projectId, mrIid);
    const existingByFingerprint = new Map<string, MrDiscussion>();
    for (const discussion of discussions) {
      const fp = fingerprintFromDiscussion(discussion);
      if (fp !== undefined && !existingByFingerprint.has(fp)) {
        existingByFingerprint.set(fp, discussion);
      }
    }

    let discussionsCreated = 0;
    for (const finding of activeFindings) {
      const fp = findingFingerprint(finding);
      if (existingByFingerprint.has(fp)) {
        continue;
      }
      const body = buildFindingBody(finding, fp);
      const position = this.#resolvePosition?.(job, finding);
      if (position !== undefined) {
        await this.#writer.createDiscussion(projectId, mrIid, body, position);
      } else {
        await this.#writer.createDiscussion(projectId, mrIid, body);
      }
      discussionsCreated += 1;
    }

    let discussionsResolved = 0;
    for (const [fp, discussion] of existingByFingerprint) {
      if (activeFingerprints.has(fp) || discussion.resolved) {
        continue;
      }
      await this.#writer.resolveDiscussion(projectId, mrIid, discussion.id, true);
      discussionsResolved += 1;
    }

    this.#logger?.info('gitlab.publish', {
      project_id: projectId,
      mr_iid: mrIid,
      summary_updated: summaryUpdated,
      discussions_created: discussionsCreated,
      discussions_resolved: discussionsResolved,
      findings_active: activeFindings.length,
    });
  }

  async #publishSummary(
    job: JobKey,
    result: ReviewResult,
    activeFindings: readonly Finding[],
  ): Promise<boolean> {
    const { projectId, mrIid } = job;
    const body = buildSummaryBody(job, result, activeFindings);
    const notes = await this.#writer.listNotes(projectId, mrIid);
    const existing = notes.find((note) => note.body.includes(SUMMARY_MARKER));

    if (existing !== undefined) {
      await this.#writer.updateNote(projectId, mrIid, existing.id, body);
      return true;
    }

    await this.#writer.createNote(projectId, mrIid, body);
    return false;
  }
}

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

function formatSeverityTally(findings: readonly Finding[]): string {
  const counts = countBySeverity(findings);
  return `${String(counts.blocker)} blocker, ${String(counts.major)} major, ${String(counts.minor)} minor, ${String(counts.nit)} nit`;
}

function formatLocation(finding: Finding): string {
  if (finding.lineStart !== undefined) {
    return `${finding.filePath}:${String(finding.lineStart)}`;
  }
  return finding.filePath;
}

function buildSummaryBody(
  job: JobKey,
  result: ReviewResult,
  activeFindings: readonly Finding[],
): string {
  const lines: string[] = [
    SUMMARY_MARKER,
    '',
    `## Mira review: **${VERDICT_LABEL[result.verdict]}**`,
    '',
    `**Findings:** ${formatSeverityTally(activeFindings)}`,
    '',
    result.summary,
  ];

  if (result.requirementsCoverage !== undefined && result.requirementsCoverage.length > 0) {
    lines.push('', '### Requirements coverage');
    for (const item of result.requirementsCoverage) {
      const evidence = item.evidence !== undefined ? ` — ${item.evidence}` : '';
      lines.push(`- **${item.status}:** ${item.criterion}${evidence}`);
    }
  }

  if (result.degradations !== undefined && result.degradations.length > 0) {
    lines.push('', '### Degradations');
    for (const note of result.degradations) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('', `_Commit ${job.headSha.slice(0, 7)}_`);
  return lines.join('\n');
}

function buildFindingBody(finding: Finding, fingerprint: string): string {
  const lines: string[] = [
    findingMarker(fingerprint),
    '',
    `**[${finding.severity} · ${finding.category}]** \`${formatLocation(finding)}\``,
    '',
    finding.message,
  ];

  if (finding.rationale !== undefined) {
    lines.push('', `**Rationale:** ${finding.rationale}`);
  }
  if (finding.suggestion !== undefined) {
    lines.push('', `**Suggestion:** ${finding.suggestion}`);
  }

  return lines.join('\n');
}
