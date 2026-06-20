/**
 * Stack-profile guidance loader (layer B of review guidance, see
 * docs/04-architecture/adr/013-layered-review-guidance.md).
 *
 * A profile is a plain-Markdown file `profiles/<name>.md` describing what a
 * reviewer should pay extra attention to for a given stack (`python`, `java`,
 * `node`, `frontend`, …). The body is injected into the reviewer prompt via the
 * `{{profile_guidance}}` placeholder; its content hash is folded into the
 * idempotency key so editing a profile re-reviews affected MRs.
 *
 * This is a thin resource loader (disk + hash), kept out of `core` like the
 * prompt template: `core` stays free of filesystem concerns.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export class ProfileError extends Error {}

interface LoadedProfile {
  /** Guidance body with the optional frontmatter stripped. */
  body: string;
  /** Short content fingerprint (`<name>@<sha8>`) for the idempotency key. */
  version: string;
}

/** Resolved set of stack profiles, queried by optional profile name. */
export interface ProfileSet {
  /** Loaded profile names (sorted). */
  readonly names: readonly string[];
  /**
   * Guidance body for a profile name. Returns `undefined` when `name` is unset.
   * Throws {@link ProfileError} when a non-empty name has no matching file.
   */
  guidanceFor(name: string | undefined): string | undefined;
  /**
   * Idempotency tag (`<name>@<sha8>`) for a profile name. Returns `undefined`
   * when `name` is unset. Throws {@link ProfileError} for an unknown name.
   */
  versionFor(name: string | undefined): string | undefined;
}

const PROFILE_EXT = '.md';

/** Strip a leading `---`-delimited YAML frontmatter block, if present. */
function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) {
    return normalized;
  }
  // Match `---\n ... \n---` only at the very start of the document.
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(normalized);
  if (match === null) {
    return normalized;
  }
  return normalized.slice(match[0].length);
}

function fingerprint(name: string, body: string): string {
  const sha8 = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
  return `${name}@${sha8}`;
}

/**
 * Load every `*.md` under `dir` into a {@link ProfileSet}. A missing directory
 * yields an empty set (no profiles configured); any policy that *names* a
 * profile will then fail validation at startup via {@link assertProfilesResolvable}.
 */
export function loadProfiles(dir: string): ProfileSet {
  const profiles = new Map<string, LoadedProfile>();

  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(PROFILE_EXT)) {
        continue;
      }
      const name = entry.name.slice(0, -PROFILE_EXT.length);
      const raw = readFileSync(path.join(dir, entry.name), 'utf8');
      const body = stripFrontmatter(raw).trim();
      profiles.set(name, { body, version: fingerprint(name, body) });
    }
  }

  const names = [...profiles.keys()].sort();

  function lookup(name: string): LoadedProfile {
    const found = profiles.get(name);
    if (found === undefined) {
      const known = names.length > 0 ? names.join(', ') : '(none)';
      throw new ProfileError(
        `Unknown review profile "${name}" in ${dir}. Known profiles: ${known}.`,
      );
    }
    return found;
  }

  return {
    names,
    guidanceFor(name) {
      if (name === undefined || name.trim() === '') {
        return undefined;
      }
      return lookup(name).body;
    },
    versionFor(name) {
      if (name === undefined || name.trim() === '') {
        return undefined;
      }
      return lookup(name).version;
    },
  };
}

/**
 * Fail fast at startup if any policy references a profile the set does not
 * contain. `names` are the profile names referenced across `defaults` +
 * per-project overrides.
 */
export function assertProfilesResolvable(profiles: ProfileSet, names: Iterable<string>): void {
  for (const name of names) {
    // Throws ProfileError with the list of known profiles when missing.
    profiles.versionFor(name);
  }
}
