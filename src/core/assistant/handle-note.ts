/**
 * Note-hook dispatcher: whitelist ChatOps commands, otherwise conversational
 * assistant in Mira threads or on a root `@mira` mention (ADR 017 / 018).
 */
import type { ReviewContext, ReviewJob } from '../domain/index.ts';
import type { ProjectPolicy } from '../policy/index.ts';
import {
  classifyNote,
  REPLY_MARKER,
  type ChatOpsCommand,
  type ClassifyNoteInput,
} from '../chatops/index.ts';
import type {
  AssistantEngine,
  AssistantRequest,
  IgnoreStore,
  MrDiscussion,
  VcsWriter,
} from '../ports/index.ts';
import { threadMessages } from './thread.ts';

/** Minimal context-builder surface so tests do not import ContextBuilder. */
export interface NoteContextBuilder {
  build(job: ReviewJob): Promise<{ context: ReviewContext; workspaceDir: string; cleanup: () => Promise<void> }>;
}

export interface HandleMrNoteLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Note Hook fields the dispatcher needs (entrypoint maps the webhook here). */
export interface IncomingMrNote {
  projectId: string;
  mrIid: number;
  headSha: string;
  body: string;
  action: string;
  system: boolean;
  noteId?: number;
  discussionId?: string;
  author?: string;
}

export interface HandleMrNoteDeps {
  enqueueReview: (job: ReviewJob) => Promise<unknown>;
  ignoreStore: IgnoreStore;
  writer: VcsWriter;
  /** When false, run the engine and log — do not POST (dry-run publisher). */
  publishReplies: boolean;
  contextBuilder: NoteContextBuilder;
  createEngine: (workspaceDir: string, policy: ProjectPolicy) => AssistantEngine;
  resolvePolicy: (projectId: string) => ProjectPolicy;
  logger: HandleMrNoteLogger;
  now: () => Date;
  botUsername?: string;
}

type AssistantChannel = AssistantRequest['kind'];

const DESCRIPTION_UPDATED_REPLY =
  'Переписала описание MR. Открой шапку запроса — если надо иначе, скажи.';

/**
 * Handle one MR note. Commands enqueue, mute, or rewrite the MR description;
 * chat builds an ephemeral checkout, asks {@link AssistantEngine}, and replies
 * in the same discussion.
 */
export async function handleMrNote(note: IncomingMrNote, deps: HandleMrNoteDeps): Promise<void> {
  const discussion = await loadDiscussion(note, deps);
  const classifyInput: ClassifyNoteInput = {
    body: note.body,
    system: note.system,
    action: note.action,
  };
  if (discussion !== undefined) {
    classifyInput.discussion = discussion;
  }
  if (note.author !== undefined) {
    classifyInput.author = note.author;
  }
  if (deps.botUsername !== undefined) {
    classifyInput.botUsername = deps.botUsername;
  }
  const intent = classifyNote(classifyInput);

  if (intent.kind === 'skip') {
    return;
  }

  if (intent.kind === 'command') {
    await dispatchCommand(note, intent.command, discussion, deps);
    return;
  }

  await runAssistant(note, intent.channel, discussion, deps);
}

async function loadDiscussion(
  note: IncomingMrNote,
  deps: HandleMrNoteDeps,
): Promise<MrDiscussion | undefined> {
  if (note.discussionId === undefined) {
    return undefined;
  }
  try {
    return await deps.writer.getDiscussion(note.projectId, note.mrIid, note.discussionId);
  } catch (cause) {
    deps.logger.warn('assistant.discussion.missing', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      discussion_id: note.discussionId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return undefined;
  }
}

async function dispatchCommand(
  note: IncomingMrNote,
  command: ChatOpsCommand,
  discussion: MrDiscussion | undefined,
  deps: HandleMrNoteDeps,
): Promise<void> {
  if (command.kind === 'ignore') {
    await deps.ignoreStore.ignore(note.projectId, note.mrIid, command.fingerprint);
    deps.logger.info('chatops.ignore', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      fingerprint: command.fingerprint,
    });
    return;
  }
  if (command.kind === 'rewrite-description') {
    await runAssistant(note, 'rewrite-description', discussion, deps);
    return;
  }
  if (note.headSha === '') {
    return;
  }
  await deps.enqueueReview({
    projectId: note.projectId,
    mrIid: note.mrIid,
    headSha: note.headSha,
    trigger: 'chatops',
    enqueuedAt: deps.now().toISOString(),
  });
  deps.logger.info('chatops.review', {
    project_id: note.projectId,
    mr_iid: note.mrIid,
    head_sha: note.headSha,
    full: command.full,
  });
}

async function runAssistant(
  note: IncomingMrNote,
  channel: AssistantChannel,
  discussion: MrDiscussion | undefined,
  deps: HandleMrNoteDeps,
): Promise<void> {
  if (note.headSha === '') {
    return;
  }

  const discussionId = note.discussionId ?? discussion?.id;
  const job: ReviewJob = {
    projectId: note.projectId,
    mrIid: note.mrIid,
    headSha: note.headSha,
    trigger: 'chatops',
    enqueuedAt: deps.now().toISOString(),
  };

  const built = await deps.contextBuilder.build(job);
  try {
    const policy = deps.resolvePolicy(note.projectId);
    const engine = deps.createEngine(built.workspaceDir, policy);
    const thread =
      discussion === undefined ? [] : threadMessages(discussion, deps.botUsername);
    const request: AssistantRequest = {
      kind: channel,
      context: built.context,
      thread,
      userMessage: note.body,
    };
    const text = (await engine.reply(request)).trim();
    if (text === '') {
      deps.logger.warn('assistant.empty_reply', {
        project_id: note.projectId,
        mr_iid: note.mrIid,
      });
      return;
    }
    if (channel === 'rewrite-description') {
      await applyRewrittenDescription(note, unwrapDescription(text), discussionId, deps);
      return;
    }
    const body = `${REPLY_MARKER}\n\n${text}`;
    if (!deps.publishReplies) {
      deps.logger.info('assistant.reply.dry_run', {
        project_id: note.projectId,
        mr_iid: note.mrIid,
        channel,
        discussion_id: discussionId,
        body,
      });
      return;
    }
    await postReply(note, discussionId, body, deps);
    deps.logger.info('assistant.reply', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      channel,
      discussion_id: discussionId,
    });
  } catch (cause) {
    deps.logger.error('assistant.failed', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      channel,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    await built.cleanup();
  }
}

async function applyRewrittenDescription(
  note: IncomingMrNote,
  description: string,
  discussionId: string | undefined,
  deps: HandleMrNoteDeps,
): Promise<void> {
  if (description === '') {
    deps.logger.warn('assistant.empty_reply', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      channel: 'rewrite-description',
    });
    return;
  }
  const body = `${REPLY_MARKER}\n\n${DESCRIPTION_UPDATED_REPLY}`;
  if (!deps.publishReplies) {
    deps.logger.info('assistant.rewrite_description.dry_run', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      discussion_id: discussionId,
      description,
      body,
    });
    return;
  }
  await deps.writer.updateMrDescription(note.projectId, note.mrIid, description);
  await postReply(note, discussionId, body, deps);
  deps.logger.info('assistant.rewrite_description', {
    project_id: note.projectId,
    mr_iid: note.mrIid,
    discussion_id: discussionId,
  });
}

async function postReply(
  note: IncomingMrNote,
  discussionId: string | undefined,
  body: string,
  deps: HandleMrNoteDeps,
): Promise<void> {
  if (discussionId !== undefined) {
    await deps.writer.addDiscussionNote(note.projectId, note.mrIid, discussionId, body);
    return;
  }
  await deps.writer.createNote(note.projectId, note.mrIid, body);
}

/** Drop a wrapping markdown fence so the PATCH body is the description itself. */
function unwrapDescription(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}
