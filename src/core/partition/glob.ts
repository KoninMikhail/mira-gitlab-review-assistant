/**
 * Minimal segment-aware glob matching for path filters (`**`, `*`, `?`).
 * Used by the partitioner to apply `ignoredGlobs` without extra dependencies.
 */

function escapeRegexLiteral(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a glob pattern to a RegExp anchored to the full path. */
export function compileGlobPattern(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let pattern = '^';
  let index = 0;

  while (index < normalized.length) {
    const char = normalized[index];
    if (char === undefined) {
      break;
    }
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 3;
        } else {
          pattern += '.*';
          index += 2;
        }
        continue;
      }
      pattern += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      index += 1;
      continue;
    }

    if (char === '/') {
      pattern += '/';
      index += 1;
      continue;
    }

    pattern += escapeRegexLiteral(char);
    index += 1;
  }

  pattern += '$';
  return new RegExp(pattern);
}

/** Return true when `path` matches at least one glob in `globs`. */
export function matchesAny(path: string, globs: string[]): boolean {
  if (globs.length === 0) {
    return false;
  }
  const normalizedPath = path.replace(/\\/g, '/');
  for (const glob of globs) {
    if (compileGlobPattern(glob).test(normalizedPath)) {
      return true;
    }
  }
  return false;
}
