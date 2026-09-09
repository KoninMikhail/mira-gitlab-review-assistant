/**
 * Minimal `.env` reader/writer. No dotenv dependency: parse at boot, upsert
 * rotatable keys after an admin update. Existing `process.env` wins on load so
 * Docker/orchestrator values are not clobbered.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const UNQUOTED_SAFE = /^[A-Za-z0-9_./:+@=-]+$/;

export type EnvMap = Record<string, string>;

/** Parse KEY=VALUE lines. Comments and blank lines are ignored. */
export function parseEnvFile(text: string): EnvMap {
  const out: EnvMap = {};
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = ASSIGN.exec(raw);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    out[match[1]] = unquoteValue(match[2]);
  }
  return out;
}

/**
 * Fill missing keys in `env` from a `.env` file. Does nothing if the file is
 * absent. Returns whether the file was read.
 */
export function applyEnvFileIfPresent(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (filePath.trim() === '' || !existsSync(filePath)) {
    return false;
  }
  const parsed = parseEnvFile(readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    const current = env[key];
    if (current === undefined || current === '') {
      env[key] = value;
    }
  }
  return true;
}

/**
 * Replace or append assignments for `updates` while preserving comments and
 * unrelated keys. Creates the file when it does not exist.
 */
export async function upsertEnvFile(filePath: string, updates: EnvMap): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return;
  }

  let text = '';
  if (existsSync(filePath)) {
    text = await readFile(filePath, 'utf8');
  }

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  // Drop a trailing empty entry that split() adds when the file ends with a newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = ASSIGN.exec(line);
    if (match === null || match[1] === undefined || !Object.hasOwn(updates, match[1])) {
      return line;
    }
    seen.add(match[1]);
    return `${match[1]}=${quoteValue(updates[match[1]] ?? '')}`;
  });

  for (const key of keys) {
    if (!seen.has(key)) {
      next.push(`${key}=${quoteValue(updates[key] ?? '')}`);
    }
  }

  const body = next.join(newline) + newline;
  await writeFile(filePath, body, 'utf8');
}

function unquoteValue(raw: string): string {
  let value = raw.trim();
  const hash = unquotedHashIndex(value);
  if (hash !== -1) {
    value = value.slice(0, hash).trimEnd();
  }
  if (value.length >= 2) {
    const start = value[0];
    const end = value[value.length - 1];
    if (start === '"' && end === '"') {
      return value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    if (start === "'" && end === "'") {
      return value.slice(1, -1);
    }
  }
  return value;
}

function unquotedHashIndex(value: string): number {
  if (value.startsWith('"') || value.startsWith("'")) {
    return -1;
  }
  const idx = value.indexOf(' #');
  return idx === -1 ? -1 : idx;
}

function quoteValue(value: string): string {
  if (value === '' || !UNQUOTED_SAFE.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}
