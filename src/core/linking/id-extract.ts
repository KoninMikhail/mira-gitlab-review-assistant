/**
 * Pure, I/O-free helpers that extract a Kaiten card id from MR text/branch.
 * Kept side-effect-free so they are trivial to unit-test in isolation.
 */

/** Compile a pattern to a stateless matcher (drop the global flag). */
function toMatcher(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern);
  return new RegExp(pattern.source, pattern.flags.replace('g', ''));
}

/** Return capture group 1 of the first match, or undefined when none matches. */
function firstCapture(text: string, pattern: RegExp | string): string | undefined {
  const match = toMatcher(pattern).exec(text);
  if (match && match[1] !== undefined) return match[1];
  return undefined;
}

/** First card id found across `patterns` (priority follows array order). */
export function extractIdFromText(
  text: string,
  patterns: readonly (RegExp | string)[],
): string | undefined {
  for (const pattern of patterns) {
    const id = firstCapture(text, pattern);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Card id parsed from a branch name via the configured branch pattern. */
export function extractIdFromBranch(
  branch: string,
  branchRegex: RegExp | string,
): string | undefined {
  return firstCapture(branch, branchRegex);
}
