/**
 * Unit tests for mirror-backed checkout. Git and filesystem IO are faked — no
 * real `git`, network, or disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { GitRunner } from './checkout.ts';
import type { MirrorFs } from './mirror-checkout.ts';
import { mirrorKey, prepareMirrorCheckout } from './mirror-checkout.ts';

interface RecordedGitCall {
  args: string[];
  cwd?: string;
}

class FakeGitRunner {
  readonly calls: RecordedGitCall[] = [];
  private readonly diffStdout: string;
  private failOnCall?: number;
  private failMessage?: string;

  constructor(diffStdout = 'DIFF') {
    this.diffStdout = diffStdout;
  }

  failOn(callIndex: number, message: string): void {
    this.failOnCall = callIndex;
    this.failMessage = message;
  }

  runner: GitRunner = async (args, options) => {
    const callIndex = this.calls.length;
    const recorded: RecordedGitCall = { args: [...args] };
    if (options.cwd !== undefined) {
      recorded.cwd = options.cwd;
    }
    this.calls.push(recorded);

    if (this.failOnCall === callIndex) {
      return { code: 1, stdout: '', stderr: this.failMessage ?? 'failure' };
    }

    const isDiff =
      args[0] === 'diff' &&
      args[1]?.startsWith('origin/') &&
      args[1]?.includes('...');

    return {
      code: 0,
      stdout: isDiff ? this.diffStdout : '',
      stderr: '',
    };
  };
}

class FakeMirrorFs implements MirrorFs {
  readonly mkdirs: string[] = [];
  private mirrorExists: boolean;

  constructor(mirrorExists = false) {
    this.mirrorExists = mirrorExists;
  }

  setMirrorExists(exists: boolean): void {
    this.mirrorExists = exists;
  }

  async exists(_filePath: string): Promise<boolean> {
    return this.mirrorExists;
  }

  async mkdir(dir: string): Promise<void> {
    this.mkdirs.push(dir);
  }
}

const REPO_URL = 'https://oauth2:secret-token@gitlab.example.com/group/app.git';
const CACHE_DIR = '/cache/mira';
const WORKSPACE_DIR = '/workspaces/mr-7';
const SOURCE_BRANCH = 'feature/x';
const TARGET_BRANCH = 'main';
const MIRROR_PATH = path.join(CACHE_DIR, mirrorKey(REPO_URL));

function expectedFirstRunCalls(): RecordedGitCall[] {
  return [
    {
      args: [
        'clone',
        '--bare',
        '--filter=blob:none',
        '--quiet',
        REPO_URL,
        MIRROR_PATH,
      ],
    },
    {
      args: [
        `--git-dir=${MIRROR_PATH}`,
        'fetch',
        '--quiet',
        '--force',
        '--filter=blob:none',
        REPO_URL,
        SOURCE_BRANCH,
        TARGET_BRANCH,
      ],
    },
    {
      args: [
        'clone',
        '--filter=blob:none',
        '--reference',
        MIRROR_PATH,
        '--no-checkout',
        '--quiet',
        REPO_URL,
        WORKSPACE_DIR,
      ],
    },
    {
      args: ['fetch', '--quiet', 'origin', SOURCE_BRANCH, TARGET_BRANCH],
      cwd: WORKSPACE_DIR,
    },
    {
      args: ['checkout', '--quiet', SOURCE_BRANCH],
      cwd: WORKSPACE_DIR,
    },
    {
      args: ['diff', `origin/${TARGET_BRANCH}...origin/${SOURCE_BRANCH}`],
      cwd: WORKSPACE_DIR,
    },
  ];
}

test('prepareMirrorCheckout first run creates mirror and workspace clone', async () => {
  const git = new FakeGitRunner();
  const fs = new FakeMirrorFs(false);

  const result = await prepareMirrorCheckout({
    repoUrl: REPO_URL,
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
    workspaceDir: WORKSPACE_DIR,
    cacheDir: CACHE_DIR,
    runGit: git.runner,
    fsOps: fs,
  });

  assert.deepEqual(git.calls, expectedFirstRunCalls());
  assert.equal(fs.mkdirs.at(-1), CACHE_DIR);
  assert.equal(result.workspaceDir, WORKSPACE_DIR);
  assert.equal(result.diff, 'DIFF');
});

test('prepareMirrorCheckout second run skips bare clone when mirror exists', async () => {
  const git = new FakeGitRunner();
  const fs = new FakeMirrorFs(true);

  const result = await prepareMirrorCheckout({
    repoUrl: REPO_URL,
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
    workspaceDir: WORKSPACE_DIR,
    cacheDir: CACHE_DIR,
    runGit: git.runner,
    fsOps: fs,
  });

  const expected = expectedFirstRunCalls().slice(1);
  assert.deepEqual(git.calls, expected);
  assert.equal(result.diff, 'DIFF');
});

test('mirrorKey strips credentials and .git suffix', () => {
  const key = mirrorKey(REPO_URL);

  assert.doesNotMatch(key, /secret-token/);
  assert.doesNotMatch(key, /oauth2/);
  assert.match(key, /gitlab\.example\.com/);
  assert.match(key, /group-app/);
  assert.doesNotMatch(key, /\.git$/);
});

test('mirrorKey is stable for the same host and path', () => {
  const a = mirrorKey('https://gitlab.example.com/group/app.git');
  const b = mirrorKey('https://oauth2:other@gitlab.example.com/group/app.git');

  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9._-]+$/);
});

test('prepareMirrorCheckout redacts token in error message', async () => {
  const git = new FakeGitRunner();
  git.failOn(0, 'auth failed for oauth2:secret-token@gitlab.example.com');

  const fs = new FakeMirrorFs(false);

  await assert.rejects(
    () =>
      prepareMirrorCheckout({
        repoUrl: REPO_URL,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        workspaceDir: WORKSPACE_DIR,
        cacheDir: CACHE_DIR,
        runGit: git.runner,
        fsOps: fs,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-token/);
      assert.match(error.message, /oauth2:\*\*\*@/);
      return true;
    },
  );
});
