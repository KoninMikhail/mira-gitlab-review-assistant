/**
 * Conversational assistant orchestration (Note Hook path, ADR 017).
 */
export { handleMrNote } from './handle-note.ts';
export type {
  HandleMrNoteDeps,
  HandleMrNoteLogger,
  IncomingMrNote,
  NoteContextBuilder,
} from './handle-note.ts';
export { threadMessages } from './thread.ts';
