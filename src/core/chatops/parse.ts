/**
 * Pure parser for `@mira` ChatOps commands in MR note bodies (docs/04-architecture/triggers.md).
 *
 * Routing stays a deterministic whitelist (ADR 017 / 018): no LLM intent classifier.
 * Review and rewrite-description accept a small set of natural-language aliases.
 */

/** Discriminated union of supported ChatOps commands. */
export type ChatOpsCommand =
  | { kind: 'review'; full: boolean }
  | { kind: 'ignore'; fingerprint: string }
  | { kind: 'rewrite-description' };

/** `@mira` mention that does not match longer names like `@mirage`. */
export const MIRA_MENTION = /@mira(?!\w)/i;

/**
 * Imperative / “do it again” phrasing around review/ревью.
 * Lone questions like «что такое ревью» must not match.
 */
const REVIEW_ALIAS =
  /(?:давай|сделай|запусти|проведи|повтори|хочу|надо|нужно|please|need|run|start).{0,60}(?:ревью|review)|(?:новое|ещё|еще)\s+(?:ревью|review)|(?:ревью|review)\s+(?:ещё|еще|снова|заново|please)/iu;

/** Rewrite-the-MR-description intent: verb + description/MR message. */
const REWRITE_DESCRIPTION =
  /(?:улучш|перепиш|обнов|поправ|отредактир|напиш|rewrite|improve|update|edit).{0,80}(?:описани|description|(?:mr|мр|merge[ -]?request).{0,24}сообщен|сообщен.{0,24}(?:mr|мр|merge[ -]?request))/iu;

/** True when the note body tags Mira (command or free-text). */
export function mentionsMira(noteBody: string): boolean {
  return MIRA_MENTION.test(noteBody);
}

/**
 * Parse the first `@mira` command in a note body.
 * Returns `undefined` when no valid command is found.
 */
export function parseChatOps(noteBody: string): ChatOpsCommand | undefined {
  const lines = noteBody.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseChatOpsLine(line);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parseChatOpsLine(line: string): ChatOpsCommand | undefined {
  const match = MIRA_MENTION.exec(line);
  if (match === null) {
    return undefined;
  }

  const afterMention = line.slice(match.index + match[0].length).trim();
  if (afterMention.length === 0) {
    return undefined;
  }

  const tokens = afterMention.split(/\s+/);
  const lowered = tokens.map((token) => token.toLowerCase());
  const first = lowered[0];

  if (first === undefined) {
    return undefined;
  }

  if (first === 'ignore') {
    return parseIgnoreCommand(tokens);
  }

  if (isReviewCommand(first, lowered, afterMention)) {
    return { kind: 'review', full: lowered.includes('--full') };
  }

  if (REWRITE_DESCRIPTION.test(afterMention)) {
    return { kind: 'rewrite-description' };
  }

  return undefined;
}

function isReviewCommand(first: string, lowered: string[], afterMention: string): boolean {
  const normalizedFirst = stripTokenPunctuation(first);
  if (normalizedFirst === 'review' || normalizedFirst === 'ревью') {
    return true;
  }
  if (first === '--full') {
    return lowered.some((token) => {
      const normalized = stripTokenPunctuation(token);
      return normalized === 'review' || normalized === 'ревью';
    });
  }
  return REVIEW_ALIAS.test(afterMention);
}

function stripTokenPunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu, '');
}

function parseIgnoreCommand(tokens: string[]): ChatOpsCommand | undefined {
  if (tokens.length < 2) {
    return undefined;
  }

  const fingerprint = tokens[1]!.trim();
  if (fingerprint.length === 0) {
    return undefined;
  }

  if (tokens.length > 2) {
    return undefined;
  }

  return { kind: 'ignore', fingerprint };
}
