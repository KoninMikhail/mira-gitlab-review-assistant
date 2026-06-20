/**
 * Ephemeral git checkout for the PoC runner.
 *
 * The unified diff is computed locally (`git diff target...source`) rather than
 * pulled from the GitLab API — per docs/03-reference/integrations-api.md §2/§6 the API diff is
 * lossy/paginated, while a local checkout gives the engine the real tree to read.
 * The git runner is injectable so unit tests need neither a real `git` nor the
 * network.
 */
import { spawn } from 'node:child_process';

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable git runner. Receives argv WITHOUT the leading `git`. */
export type GitRunner = (args: string[], options: { cwd?: string }) => Promise<GitRunResult>;

export interface PrepareCheckoutOptions {
  /** Clone URL including auth (see {@link buildCloneUrl}). */
  repoUrl: string;
  sourceBranch: string;
  targetBranch: string;
  /** Directory to clone into (created by `git clone`). */
  workspaceDir: string;
  /** Injectable for tests; defaults to a `node:child_process` impl. */
  runGit?: GitRunner;
}

export interface CheckoutResult {
  workspaceDir: string;
  /** Unified diff, `target...source`, captured from the local checkout. */
  diff: string;
}

/**
 * Build an authenticated https clone URL from the GitLab base URL and a project
 * PATH (e.g. `group/sub/project`). Numeric project ids cannot be cloned by path,
 * so the PoC checkout requires a path-form `--project`.
 *
 * The token is embedded as the `oauth2` password. Caveat: git persists the
 * remote URL (incl. token) in the clone's `.git/config`; acceptable for an
 * ephemeral, auto-deleted PoC checkout.
 */
export function buildCloneUrl(baseUrl: string, projectPath: string, token: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = projectPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const url = new URL(`${trimmedBase}/${trimmedPath}.git`);
  url.username = 'oauth2';
  url.password = token;
  return url.toString();
}

/**
 * Clone (blobless partial), fetch source+target, checkout source, and return the
 * local `target...source` diff. A blobless clone keeps full history so the
 * `...` merge-base resolves, while deferring file contents for speed.
 */
export async function prepareCheckout(options: PrepareCheckoutOptions): Promise<CheckoutResult> {
  const runGit = options.runGit ?? defaultGitRunner;
  const { repoUrl, sourceBranch, targetBranch, workspaceDir } = options;

  await run(
    runGit,
    ['clone', '--filter=blob:none', '--no-checkout', '--quiet', repoUrl, workspaceDir],
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

/** Strip a token embedded as `oauth2:<token>@` so it never reaches logs/errors. */
function redact(text: string): string {
  return text.replace(/(oauth2:)[^@\s/]+(@)/g, '$1***$2');
}

function defaultGitRunner(args: string[], options: { cwd?: string }): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      // Non-interactive: fail fast instead of hanging on a credential prompt.
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
