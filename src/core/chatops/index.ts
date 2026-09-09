/**
 * ChatOps: whitelist commands plus deterministic routing of conversational notes.
 */

export { parseChatOps, mentionsMira, MIRA_MENTION, type ChatOpsCommand } from './parse.ts';
export {
  SUMMARY_MARKER,
  REPLY_MARKER,
  FINDING_MARKER_RE,
  findingMarker,
  isMiraReply,
  miraThreadKind,
} from './markers.ts';
export { classifyNote, type ClassifyNoteInput, type NoteIntent, type NoteSkipReason } from './classify.ts';
