/**
 * Pure parser for `@mira` ChatOps commands in MR note bodies (docs/04-architecture/triggers.md).
 */

/** Discriminated union of supported ChatOps commands. */
export type ChatOpsCommand =
  | { kind: 'review'; full: boolean }
  | { kind: 'ignore'; fingerprint: string };

const MIRA_MENTION = /@mira(?!\w)/i;

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

  if (first === 'review' || first === '--full') {
    return parseReviewCommand(lowered);
  }

  return undefined;
}

function parseReviewCommand(lowered: string[]): ChatOpsCommand | undefined {
  if (!lowered.includes('review')) {
    return undefined;
  }

  return { kind: 'review', full: lowered.includes('--full') };
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
