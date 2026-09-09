/**
 * Hidden HTML-comment markers Mira embeds in MR notes. They survive GitLab
 * Markdown rendering and identify Mira-owned threads without relying on
 * usernames. Publisher and ChatOps both import from here so core never
 * reaches into the GitLab adapter.
 */

/** Hidden marker for the single MR summary note. */
export const SUMMARY_MARKER = '<!-- mira:summary -->';

/** Hidden marker prefixed to conversational replies (loop-prevention). */
export const REPLY_MARKER = '<!-- mira:reply -->';

/** Build the finding fingerprint marker embedded in a discussion body. */
export function findingMarker(fingerprint: string): string {
  return `<!-- mira:finding:${fingerprint} -->`;
}

/** Extract a finding fingerprint from a note/discussion body, if present. */
export const FINDING_MARKER_RE = /<!-- mira:finding:([a-f0-9]+) -->/;

/** True when this note body is a Mira conversational reply. */
export function isMiraReply(body: string): boolean {
  return body.includes(REPLY_MARKER);
}

/**
 * Classify a discussion from its first note: Mira finding thread, Mira
 * summary thread, or neither.
 */
export function miraThreadKind(firstNoteBody: string): 'finding' | 'summary' | undefined {
  if (FINDING_MARKER_RE.test(firstNoteBody)) {
    return 'finding';
  }
  if (firstNoteBody.includes(SUMMARY_MARKER)) {
    return 'summary';
  }
  return undefined;
}
