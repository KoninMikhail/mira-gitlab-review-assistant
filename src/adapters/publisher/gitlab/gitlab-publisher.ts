/**
 * `GitLabPublisher` — idempotent phase-2 `Publisher`. Writes one updatable summary
 * note and one discussion per finding (inline when `resolvePosition` yields a
 * diff anchor). After a real review, sets or clears the bot's GitLab Approve as
 * a consultative signal for the team lead (ADR 016). Markers in HTML comments
 * survive Markdown rendering and drive dedup across re-runs
 * (docs/04-architecture/review-pipeline.md §6).
 */
import type {
  Finding,
  JobKey,
  RequirementStatus,
  ReviewResult,
  Severity,
} from '../../../core/domain/index.ts';
import { findingFingerprint } from '../../../core/idempotency/fingerprint.ts';
import { ackMarker, isPresenceAck, presenceKindOf } from '../../../core/presence/index.ts';
import { isUnavailableReview } from '../../../core/unavailable-review.ts';
import type {
  IgnoreStore,
  InlinePosition,
  MrDiscussion,
  PublishInput,
  Publisher,
  VcsWriter,
} from '../../../core/ports/index.ts';
import {
  FINDING_MARKER_RE,
  SUMMARY_MARKER,
  findingMarker,
} from '../../../core/chatops/index.ts';

export { FINDING_MARKER_RE, SUMMARY_MARKER, findingMarker };

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'major', 'minor'];

const VERDICT_LABEL: Record<ReviewResult['verdict'], string> = {
  ok: 'можно мержить',
  risks: 'есть риски',
  blockers: 'так мержить нельзя',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Критично',
  major: 'Важно',
  minor: 'На заметку',
};

const CATEGORY_LABEL: Record<Finding['category'], string> = {
  bug: 'баг',
  security: 'безопасность',
  perf: 'производительность',
  requirements: 'задача',
  maintainability: 'сопровождение',
  style: 'стиль',
};

const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  met: 'сделано',
  partial: 'частично',
  missing: 'не сделано',
  unknown: 'не поняла',
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
  /**
   * Resolve a diff anchor for an inline discussion. May be async (e.g. needs to
   * fetch MR diff refs). Return `undefined` to post a general (non-inline) note.
   */
  resolvePosition?: (
    job: JobKey,
    finding: Finding,
  ) => InlinePosition | undefined | Promise<InlinePosition | undefined>;
}

/** Tally findings per severity (all buckets present, even at zero). */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
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
    const { job, result, cardLinked } = input;
    const { projectId, mrIid } = job;

    const muted =
      this.#ignoreStore === undefined
        ? new Set<string>()
        : await this.#ignoreStore.ignored(projectId, mrIid);

    const activeFindings = orderFindings(
      result.findings.filter((finding) => !muted.has(findingFingerprint(finding))),
    );
    const activeFingerprints = new Set(activeFindings.map((f) => findingFingerprint(f)));

    const summaryUpdated = await this.#publishSummary(
      job,
      result,
      activeFindings,
      cardLinked,
      input.freshSummary === true,
    );

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
      const position = await this.#resolvePosition?.(job, finding);
      if (position !== undefined) {
        try {
          await this.#writer.createDiscussion(projectId, mrIid, body, position);
        } catch (error: unknown) {
          // GitLab rejects positions for lines outside the diff (HTTP 400).
          this.#logger?.warn('gitlab.publish.inline_fallback', {
            project_id: projectId,
            mr_iid: mrIid,
            file_path: finding.filePath,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.#writer.createDiscussion(projectId, mrIid, body);
        }
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

    const approval = await this.#syncApproval(job, result);

    this.#logger?.info('gitlab.publish', {
      project_id: projectId,
      mr_iid: mrIid,
      summary_updated: summaryUpdated,
      discussions_created: discussionsCreated,
      discussions_resolved: discussionsResolved,
      findings_active: activeFindings.length,
      approval,
    });
  }

  /**
   * Consultative GitLab Approve for the team lead: `ok` → approve this SHA;
   * `risks`/`blockers` → drop the bot's own approval. Presence/unavailable
   * comments must not look like a green review.
   */
  async #syncApproval(
    job: JobKey,
    result: ReviewResult,
  ): Promise<'approved' | 'unapproved' | 'skipped' | 'failed'> {
    if (isPresenceAck(result) || isUnavailableReview(result)) {
      return 'skipped';
    }

    const { projectId, mrIid, headSha } = job;
    try {
      if (result.verdict === 'ok') {
        await this.#writer.approveMr(projectId, mrIid, headSha);
        return 'approved';
      }
      await this.#writer.unapproveMr(projectId, mrIid);
      return 'unapproved';
    } catch (error) {
      this.#logger?.warn('gitlab.approval_failed', {
        project_id: projectId,
        mr_iid: mrIid,
        sha: headSha,
        verdict: result.verdict,
        err: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  async #publishSummary(
    job: JobKey,
    result: ReviewResult,
    activeFindings: readonly Finding[],
    cardLinked: boolean | undefined,
    freshSummary: boolean,
  ): Promise<boolean> {
    const { projectId, mrIid } = job;
    const body = buildSummaryBody(job, result, activeFindings, cardLinked);
    const notes = await this.#writer.listNotes(projectId, mrIid);
    const summaries = notes.filter((note) => note.body.includes(SUMMARY_MARKER));
    const inProgress = lastNoteWithAck(summaries, job.headSha);
    const existing = inProgress ?? (freshSummary ? undefined : summaries[0]);

    // Retries while waiting on CI must not rotate the joke for this SHA.
    const ackKind = presenceKindOf(result);
    if (
      isPresenceAck(result) &&
      ackKind !== undefined &&
      existing !== undefined &&
      existing.body.includes(ackMarker(job.headSha, ackKind))
    ) {
      return false;
    }

    if (existing !== undefined) {
      await this.#writer.updateNote(projectId, mrIid, existing.id, body);
      return true;
    }

    await this.#writer.createNote(projectId, mrIid, body);
    return false;
  }
}

/** Newest presence ack for this SHA — the note this run should keep editing. */
function lastNoteWithAck(notes: readonly { id: number; body: string }[], sha: string) {
  const needle = `<!-- mira:ack:${sha}:`;
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    if (note !== undefined && note.body.includes(needle)) {
      return note;
    }
  }
  return undefined;
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

/** Human tally for the summary; empty buckets are omitted. */
export function formatSeverityTally(findings: readonly Finding[]): string {
  const counts = countBySeverity(findings);
  const parts: string[] = [];
  if (counts.critical > 0) {
    parts.push(ruCount(counts.critical, 'критичное', 'критичных'));
  }
  if (counts.major > 0) {
    parts.push(ruCount(counts.major, 'важное', 'важных'));
  }
  if (counts.minor > 0) {
    parts.push(`${String(counts.minor)} на заметку`);
  }
  return parts.join(', ');
}

function ruCount(count: number, one: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : many;
  return `${String(count)} ${word}`;
}

function formatLocation(finding: Finding): string {
  if (finding.lineStart !== undefined) {
    return `${finding.filePath}:${String(finding.lineStart)}`;
  }
  return finding.filePath;
}

/**
 * Friendly note shown when the MR has no linked Kaiten card: explains, in Mira's
 * voice, how to attach one so the next review can be checked against the task.
 */
const NO_KAITEN_CARD_NOTE = [
  'Требований по задаче в Kaiten я не нашла, поэтому сверялась только с самим diff MR.',
  'Чтобы я могла проверить изменения против задачи, привяжи карточку Kaiten любым из способов:',
  '',
  '- ветка вида `feature/1234-краткое-описание`, где `1234` — id карточки;',
  '- ссылка на карточку в описании MR: `https://ai-referent.kaiten.ru/cards/1234`;',
  '- упоминание `KAITEN-1234` или `#1234` в заголовке или описании MR.',
].join('\n');

function buildSummaryBody(
  job: JobKey,
  result: ReviewResult,
  activeFindings: readonly Finding[],
  cardLinked: boolean | undefined,
): string {
  if (isUnavailableReview(result) || isPresenceAck(result)) {
    const lines = [SUMMARY_MARKER];
    if (isPresenceAck(result)) {
      const kind = presenceKindOf(result);
      if (kind !== undefined) {
        lines.push(ackMarker(job.headSha, kind));
      }
    }
    lines.push('', result.summary, '', `_Коммит ${job.headSha.slice(0, 7)}_`);
    return lines.join('\n');
  }

  const tally = formatSeverityTally(activeFindings);
  const findingsLine =
    tally.length > 0 ? `Нашла: **${tally}**.` : 'Замечаний по делу нет — придраться почти не к чему.';

  const lines: string[] = [
    SUMMARY_MARKER,
    '',
    '## Сделала ревью',
    '',
    `**Вердикт: ${VERDICT_LABEL[result.verdict]}**`,
    '',
    findingsLine,
    '',
    result.summary,
  ];

  if (cardLinked === false) {
    lines.push('', '### По задаче', '', NO_KAITEN_CARD_NOTE);
  } else if (result.requirementsCoverage !== undefined && result.requirementsCoverage.length > 0) {
    lines.push('', '### По задаче');
    for (const item of result.requirementsCoverage) {
      const status = REQUIREMENT_STATUS_LABEL[item.status];
      const evidence = item.evidence !== undefined ? ` — ${item.evidence}` : '';
      lines.push(`- **${status}:** ${item.criterion}${evidence}`);
    }
  }

  if (result.degradations !== undefined && result.degradations.length > 0) {
    lines.push('', '### Что не доглядела');
    for (const note of result.degradations) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('', `_Коммит ${job.headSha.slice(0, 7)}_`);
  return lines.join('\n');
}

function buildFindingBody(finding: Finding, fingerprint: string): string {
  const lines: string[] = [
    findingMarker(fingerprint),
    '',
    `**${SEVERITY_LABEL[finding.severity]}** · ${CATEGORY_LABEL[finding.category]} · \`${formatLocation(finding)}\``,
    '',
    finding.message,
  ];

  if (finding.rationale !== undefined) {
    lines.push('', `*Почему:* ${finding.rationale}`);
  }
  if (finding.suggestion !== undefined) {
    lines.push('', `*Как поправить:* ${finding.suggestion}`);
  }

  return lines.join('\n');
}
