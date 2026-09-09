/**
 * Parse a Cursor API key pool from one env value. Separators: comma, semicolon,
 * newline. Order is kept; blanks are dropped; duplicates are removed.
 */
const SPLIT = /[,;\n\r]+/;

export function parseCursorApiKeys(raw: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const part of raw.split(SPLIT)) {
    const key = part.trim();
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Persist a pool as a single `.env` value (quoted by the env-file writer if needed). */
export function serializeCursorApiKeys(keys: string[]): string {
  return parseCursorApiKeys(keys.join(',')).join(',');
}
