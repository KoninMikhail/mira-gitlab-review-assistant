/**
 * Ephemeral workspace naming and TTL garbage collection for checkout dirs under
 * a shared root (e.g. `os.tmpdir()`). All filesystem access is injectable so
 * unit tests never touch the real disk.
 */
import path from 'node:path';

export interface WorkspaceGcFs {
  readdir(dir: string): Promise<string[]>;
  stat(filePath: string): Promise<{ mtimeMs: number }>;
  rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface BuildWorkspaceDirNameOptions {
  projectId: string;
  mrIid: number;
  now: Date;
}

/** Stable, filesystem-safe name for one MR checkout under a shared root. */
export function buildWorkspaceDirName(options: BuildWorkspaceDirNameOptions): string {
  const slug = options.projectId.replace(/[^\w.-]+/g, '-');
  return `mira-work-${slug}-mr${String(options.mrIid)}-${String(options.now.getTime())}`;
}

export interface BuildWorkspacePathOptions extends BuildWorkspaceDirNameOptions {
  rootDir: string;
}

/** Absolute path for a fresh workspace directory under `rootDir`. */
export function buildWorkspacePath(options: BuildWorkspacePathOptions): string {
  return path.join(
    options.rootDir,
    buildWorkspaceDirName({
      projectId: options.projectId,
      mrIid: options.mrIid,
      now: options.now,
    }),
  );
}

export interface GcWorkspacesOptions {
  rootDir: string;
  ttlMs: number;
  now: Date;
  fs: WorkspaceGcFs;
}

/**
 * Remove workspace entries under `rootDir` whose `mtimeMs` is older than
 * `ttlMs` relative to `now`. Returns the absolute paths that were removed.
 * Missing `rootDir` is treated as empty (no throw).
 */
export async function gcWorkspaces(options: GcWorkspacesOptions): Promise<string[]> {
  const cutoff = options.now.getTime() - options.ttlMs;
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await options.fs.readdir(options.rootDir);
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const fullPath = path.join(options.rootDir, entry);
    const stat = await options.fs.stat(fullPath);
    if (stat.mtimeMs < cutoff) {
      await options.fs.rm(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    }
  }

  return removed;
}
