/**
 * Deterministic Note-hook router: system commands stay a whitelist (review
 * aliases, ignore, rewrite-description); everything else is either a
 * conversation or silence. No LLM classification
 * (docs/04-architecture/adr/017-assistant-chat.md,
 * docs/04-architecture/adr/018-chatops-aliases-and-mr-description.md).
 */
import type { MrDiscussion } from '../ports/index.ts';
import { isMiraReply, miraThreadKind } from './markers.ts';
import { parseChatOps, mentionsMira, type ChatOpsCommand } from './parse.ts';

export type NoteSkipReason = 'system' | 'bot' | 'update' | 'own-reply' | 'unrelated';

export type NoteIntent =
  | { kind: 'skip'; reason: NoteSkipReason }
  | { kind: 'command'; command: ChatOpsCommand }
  | { kind: 'chat'; channel: 'thread' | 'root' };

export interface ClassifyNoteInput {
  body: string;
  system: boolean;
  /** GitLab note action; missing / `create` are treated as create. */
  action: string;
  author?: string;
  botUsername?: string;
  discussion?: MrDiscussion;
}

/**
 * Route an MR note. Commands win everywhere (emergency hatch). Replies in a
 * Mira-owned thread become conversation without requiring `@mira`. A new
 * root comment only becomes conversation when it tags `@mira`.
 */
export function classifyNote(input: ClassifyNoteInput): NoteIntent {
  if (input.system) {
    return { kind: 'skip', reason: 'system' };
  }
  if (input.action !== '' && input.action !== 'create') {
    return { kind: 'skip', reason: 'update' };
  }
  if (isMiraReply(input.body)) {
    return { kind: 'skip', reason: 'own-reply' };
  }
  if (isBotAuthor(input.author, input.botUsername)) {
    return { kind: 'skip', reason: 'bot' };
  }

  const command = parseChatOps(input.body);
  if (command !== undefined) {
    return { kind: 'command', command };
  }

  const first = input.discussion?.notes[0];
  if (first !== undefined && miraThreadKind(first.body) !== undefined) {
    return { kind: 'chat', channel: 'thread' };
  }
  if (mentionsMira(input.body)) {
    return { kind: 'chat', channel: 'root' };
  }
  return { kind: 'skip', reason: 'unrelated' };
}

function isBotAuthor(author: string | undefined, botUsername: string | undefined): boolean {
  if (author === undefined || botUsername === undefined || botUsername === '') {
    return false;
  }
  return author.toLowerCase() === botUsername.toLowerCase();
}
