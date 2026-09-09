/**
 * Map a VCS discussion to assistant transcript turns.
 */
import { isMiraReply, miraThreadKind } from '../chatops/index.ts';
import type { AssistantThreadMessage, MrDiscussion } from '../ports/index.ts';

export function threadMessages(
  discussion: MrDiscussion,
  botUsername: string | undefined,
): AssistantThreadMessage[] {
  const messages: AssistantThreadMessage[] = [];
  for (const note of discussion.notes) {
    if (note.system) {
      continue;
    }
    const role: AssistantThreadMessage['role'] = isMiraRole(note.body, note.author, botUsername)
      ? 'mira'
      : 'user';
    const message: AssistantThreadMessage = { role, body: note.body };
    if (note.author !== undefined) {
      message.author = note.author;
    }
    messages.push(message);
  }
  return messages;
}

function isMiraRole(body: string, author: string | undefined, botUsername: string | undefined): boolean {
  if (isMiraReply(body) || miraThreadKind(body) !== undefined) {
    return true;
  }
  if (author === undefined || botUsername === undefined || botUsername === '') {
    return false;
  }
  return author.toLowerCase() === botUsername.toLowerCase();
}
