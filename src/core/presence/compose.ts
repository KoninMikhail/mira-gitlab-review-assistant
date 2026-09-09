/**
 * Copy and helpers for the pre-review MR presence comment (CI wait / start).
 * Keep this out of the GitLab adapter so LogPublisher gets the same summary.
 */
import type { ReviewResult } from '../domain/index.ts';
import type { PresenceKind } from '../ci/index.ts';
import { defaultLinkResolverConfig, extractIdFromText } from '../linking/index.ts';
import {
  FORGOT_TASK_MESSAGES,
  START_GREEN_MESSAGES,
  START_NO_CI_MESSAGES,
  START_RED_MESSAGES,
  START_TIMEOUT_MESSAGES,
  WAIT_FOOTER,
  WAIT_MESSAGES,
} from './messages.ts';

/** Sentinel degradation; publisher skips the "OK / 0 findings" heading. */
export const PRESENCE_ACK_NOTE = 'presence-ack';

const LEADS: Record<PresenceKind, readonly string[]> = {
  wait: WAIT_MESSAGES,
  green: START_GREEN_MESSAGES,
  red: START_RED_MESSAGES,
  none: START_NO_CI_MESSAGES,
  timeout: START_TIMEOUT_MESSAGES,
};

/** Hidden per-SHA+kind marker so wait retries do not rotate the joke. */
export function ackMarker(sha: string, kind: PresenceKind): string {
  return `<!-- mira:ack:${sha}:${kind} -->`;
}

export function presenceKindNote(kind: PresenceKind): string {
  return `presence-kind:${kind}`;
}

export function presenceKindOf(result: ReviewResult): PresenceKind | undefined {
  const note = result.degradations?.find((item) => item.startsWith('presence-kind:'));
  if (note === undefined) {
    return undefined;
  }
  const kind = note.slice('presence-kind:'.length);
  if (
    kind === 'wait' ||
    kind === 'green' ||
    kind === 'red' ||
    kind === 'none' ||
    kind === 'timeout'
  ) {
    return kind;
  }
  return undefined;
}

export function pickOne(items: readonly string[], random: () => number = Math.random): string {
  const count = items.length;
  const index = Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
  return items[index] ?? items[0] ?? '';
}

/** True when the MR *description* has no extractable card id (branch does not count). */
export function descriptionMissesTaskLink(description: string): boolean {
  const patterns = defaultLinkResolverConfig.descriptionPatterns ?? [];
  return extractIdFromText(description, patterns) === undefined;
}

export function composePresenceSummary(
  kind: PresenceKind,
  description: string,
  random: () => number = Math.random,
): string {
  const parts = [pickOne(LEADS[kind], random)];
  if (descriptionMissesTaskLink(description)) {
    parts.push(pickOne(FORGOT_TASK_MESSAGES, random));
  }
  if (kind === 'wait') {
    parts.push(WAIT_FOOTER);
  }
  return parts.join('\n\n');
}

export function isPresenceAck(result: ReviewResult): boolean {
  return result.degradations?.includes(PRESENCE_ACK_NOTE) === true;
}

export function presenceAckResult(summary: string, kind: PresenceKind): ReviewResult {
  return {
    verdict: 'ok',
    summary,
    findings: [],
    degradations: [PRESENCE_ACK_NOTE, presenceKindNote(kind)],
  };
}
