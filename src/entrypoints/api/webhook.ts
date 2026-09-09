/**
 * GitLab webhook parsing and normalization. Pure functions only — no HTTP I/O.
 */
import type { ReviewJob, TriggerKind } from '../../core/domain/index.ts';
import type { ProjectPolicy } from '../../core/policy/types.ts';

/** Normalized Merge Request Hook payload. */
export interface MrWebhookEvent {
  kind: 'mr';
  projectId: string;
  mrIid: number;
  headSha: string;
  action: string;
  isDraft: boolean;
  /** Draft → ready transition on this update. */
  draftTransition: boolean;
  /** New commits pushed (`oldrev` present on the hook). */
  hasNewCommits: boolean;
}

/** Normalized Note Hook payload for MR comments. */
export interface NoteWebhookEvent {
  kind: 'note';
  projectId: string;
  mrIid: number;
  headSha: string;
  body: string;
  /** GitLab note action; `create` when the payload omits it. */
  action: string;
  /** GitLab system notes (state changes); never a human talking to Mira. */
  system: boolean;
  /** GitLab note id, when present. */
  noteId?: number;
  /** Discussion thread id, when present — required to reply in-thread. */
  discussionId?: string;
  author?: string;
}

export type WebhookEvent = MrWebhookEvent | NoteWebhookEvent;

/**
 * Verify the GitLab shared secret header. When `secret` is an empty string,
 * verification is disabled and this always returns true.
 */
export function verifyToken(token: string | undefined, secret: string): boolean {
  if (secret === '') {
    return true;
  }
  if (token === undefined) {
    return false;
  }
  if (token.length !== secret.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < secret.length; i += 1) {
    mismatch |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Parse a GitLab webhook into a normalized event. Returns `undefined` for
 * unsupported event types, non-MR notes, or malformed payloads (never throws).
 */
export function parseWebhookEvent(
  eventHeader: string | undefined,
  payload: unknown,
): WebhookEvent | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const root = payload as Record<string, unknown>;

  if (eventHeader === 'Merge Request Hook' && root['object_kind'] === 'merge_request') {
    return parseMrHook(root);
  }
  if (eventHeader === 'Note Hook' && root['object_kind'] === 'note') {
    return parseNoteHook(root);
  }
  return undefined;
}

/**
 * Map a parsed MR webhook to a {@link ReviewJob}, honoring `policy.reviewOn`.
 * Returns `undefined` when the event should be ignored.
 */
export function mrEventToJob(
  event: MrWebhookEvent,
  policy: ProjectPolicy,
  now: () => Date,
): ReviewJob | undefined {
  if (event.headSha === '') {
    return undefined;
  }

  const trigger = pickMrTrigger(event, policy.reviewOn);
  if (trigger === undefined) {
    return undefined;
  }

  return {
    projectId: event.projectId,
    mrIid: event.mrIid,
    headSha: event.headSha,
    trigger,
    enqueuedAt: now().toISOString(),
  };
}

function pickMrTrigger(
  event: MrWebhookEvent,
  reviewOn: ProjectPolicy['reviewOn'],
): TriggerKind | undefined {
  switch (event.action) {
    case 'open':
      if (!event.isDraft && reviewOn.open) {
        return 'open';
      }
      return undefined;
    case 'reopen':
      if (reviewOn.reopen) {
        return 'reopen';
      }
      return undefined;
    case 'update':
      if (event.draftTransition && reviewOn.ready) {
        return 'ready';
      }
      if (event.hasNewCommits && reviewOn.push) {
        return 'push';
      }
      return undefined;
    default:
      return undefined;
  }
}

function parseMrHook(root: Record<string, unknown>): MrWebhookEvent | undefined {
  const project = asRecord(root['project']);
  const attrs = asRecord(root['object_attributes']);
  if (project === undefined || attrs === undefined) {
    return undefined;
  }

  const mrIid = attrs['iid'];
  const action = attrs['action'];
  const lastCommit = asRecord(attrs['last_commit']);
  if (typeof mrIid !== 'number' || typeof action !== 'string' || lastCommit === undefined) {
    return undefined;
  }

  const headSha = lastCommit['id'];
  if (typeof headSha !== 'string') {
    return undefined;
  }

  const pathNs = project['path_with_namespace'];
  const projectId =
    typeof pathNs === 'string'
      ? pathNs
      : typeof project['id'] === 'number'
        ? String(project['id'])
        : undefined;
  if (projectId === undefined) {
    return undefined;
  }

  const draftChange = asRecord(asRecord(root['changes'])?.['draft']);

  return {
    kind: 'mr',
    projectId,
    mrIid,
    headSha,
    action,
    isDraft: attrs['work_in_progress'] === true,
    draftTransition: draftChange?.['previous'] === true && draftChange?.['current'] === false,
    hasNewCommits: attrs['oldrev'] !== undefined,
  };
}

function parseNoteHook(root: Record<string, unknown>): NoteWebhookEvent | undefined {
  const attrs = asRecord(root['object_attributes']);
  const mergeRequest = asRecord(root['merge_request']);
  const project = asRecord(root['project']);
  if (attrs === undefined || mergeRequest === undefined || project === undefined) {
    return undefined;
  }

  if (attrs['noteable_type'] !== 'MergeRequest') {
    return undefined;
  }

  const mrIid = mergeRequest['iid'];
  const lastCommit = asRecord(mergeRequest['last_commit']);
  const body = attrs['note'];
  if (typeof mrIid !== 'number' || lastCommit === undefined || typeof body !== 'string') {
    return undefined;
  }

  const headSha = lastCommit['id'];
  if (typeof headSha !== 'string') {
    return undefined;
  }

  const pathNs = project['path_with_namespace'];
  const projectId =
    typeof pathNs === 'string'
      ? pathNs
      : typeof project['id'] === 'number'
        ? String(project['id'])
        : undefined;
  if (projectId === undefined) {
    return undefined;
  }

  const user = asRecord(root['user']);
  const username = user?.['username'];
  const actionRaw = attrs['action'];
  const action = typeof actionRaw === 'string' && actionRaw !== '' ? actionRaw : 'create';
  const event: NoteWebhookEvent = {
    kind: 'note',
    projectId,
    mrIid,
    headSha,
    body,
    action,
    system: attrs['system'] === true,
  };
  const noteId = attrs['id'];
  if (typeof noteId === 'number') {
    event.noteId = noteId;
  }
  const discussionId = attrs['discussion_id'];
  if (typeof discussionId === 'string' && discussionId !== '') {
    event.discussionId = discussionId;
  }
  if (typeof username === 'string') {
    event.author = username;
  }
  return event;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}
