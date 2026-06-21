/**
 * Mirror-backed git checkout for repeated reviews of the same repository.
 *
 * Maintains a persistent bare object cache and clones ephemeral workspaces with
 * `--reference` so repeated checkouts reuse objects without worktree bookkeeping.
 */
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  CheckoutResult,
  GitRunResult,
  GitRunner,
  PrepareCheckoutOptions,
} from './checkout.ts';

export interface MirrorFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export interface PrepareMirrorCheckoutOptions extends PrepareCheckoutOptions {
  /** Persistent cache root holding per-repo bare mirrors. */
  cacheDir: string;
  /** Injectable fs ops for tests; defaults to node:fs/promises based impl. */
  fsOps?: MirrorFs;
}

const defaultFsOps: MirrorFs = {
  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(filePath: string): Promise<void> {
    await mkdir(filePath, { recursive: true });
  },
};

/**
 * Derive a stable, filesystem-safe cache key from a clone URL without credentials.
 */
export function mirrorKey(repoUrl: string): string {
  const url = new URL(repoUrl);
  const raw = url.host + url.pathname;
  const normalized = raw.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return normalized.replace(/\.git$/i, '');
}

/**
 * Clone via a persistent bare mirror cache, fetch source+target, checkout source,
 * and return the local `target...source` diff.
 */
export async function prepareMirrorCheckout(
  options: PrepareMirrorCheckoutOptions,
): Promise<CheckoutResult> {
  const runGit = options.runGit ?? defaultGitRunner;
  const fsOps = options.fsOps ?? defaultFsOps;
  const { repoUrl, sourceBranch, targetBranch, workspaceDir, cacheDir } = options;
  const mirrorPath = path.join(cacheDir, mirrorKey(repoUrl));

  await fsOps.mkdir(cacheDir);

  if (!(await fsOps.exists(mirrorPath))) {
    await run(runGit, ['clone', '--bare', '--filter=blob:none', '--quiet', repoUrl, mirrorPath], {});
  }

  await run(
    runGit,
    [
      `--git-dir=${mirrorPath}`,
      'fetch',
      '--quiet',
      '--force',
      '--filter=blob:none',
      repoUrl,
      sourceBranch,
      targetBranch,
    ],
    {},
  );

  await run(
    runGit,
    [
      'clone',
      '--filter=blob:none',
      '--reference',
      mirrorPath,
      '--no-checkout',
      '--quiet',
      repoUrl,
      workspaceDir,
    ],
    {},
  );

  await run(runGit, ['fetch', '--quiet', 'origin', sourceBranch, targetBranch], {
    cwd: workspaceDir,
  });
  await run(runGit, ['checkout', '--quiet', sourceBranch], { cwd: workspaceDir });

  const diff = await run(runGit, ['diff', `origin/${targetBranch}...origin/${sourceBranch}`], {
    cwd: workspaceDir,
  });

  return { workspaceDir, diff: diff.stdout };
}

async function run(
  runGit: GitRunner,
  args: string[],
  options: { cwd?: string },
): Promise<GitRunResult> {
  const result = await runGit(args, options);
  if (result.code !== 0) {
    const detail = redact(result.stderr.trim() || result.stdout.trim() || '(no output)');
    throw new Error(
      `git ${redact(args.join(' '))} failed (code ${String(result.code)}): ${detail}`,
    );
  }
  return result;
}

function redact(text: string): string {
  return text.replace(/(oauth2:)[^@\s/]+(@)/g, '$1***$2');
}

function defaultGitRunner(args: string[], options: { cwd?: string }): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
