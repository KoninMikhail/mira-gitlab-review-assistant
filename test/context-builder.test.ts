/**
 * Unit tests for ContextBuilder and workspace GC. All IO is faked — no real git,
 * network, or filesystem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { MrContext } from '../src/core/ports/index.ts';
import type { ReviewJob, TaskCard } from '../src/core/domain/index.ts';
import type { CheckoutResult, PrepareCheckoutOptions } from '../src/core/context/checkout.ts';
import type { ContextFs } from '../src/core/context/context-builder.ts';
import { ContextBuilder } from '../src/core/context/context-builder.ts';
import type { WorkspaceGcFs } from '../src/core/context/workspace.ts';
import { buildWorkspaceDirName, gcWorkspaces } from '../src/core/context/workspace.ts';
import { FakeClock, FakeTaskTracker, FakeVcsReader } from './fakes.ts';

function makeJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    projectId: 'group/app',
    mrIid: 7,
    headSha: 'sha-a',
    trigger: 'poll',
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMr(overrides: Partial<MrContext> = {}): MrContext {
  return {
    projectId: 'group/app',
    mrIid: 7,
    title: 'Add feature',
    description: 'Implements KAITEN-4567.',
    sourceBranch: 'feature/4567-add-feature',
    targetBranch: 'main',
    headSha: 'sha-a',
    changedFiles: [{ path: 'src/a.ts', isBinary: false, isNew: false, isDeleted: false }],
    ...overrides,
  };
}

class FakeContextFs implements ContextFs {
  readonly mkdirs: string[] = [];
  readonly writes: Array<{ file: string; data: string }> = [];
  readonly removed: string[] = [];

  async mkdir(dir: string): Promise<void> {
    this.mkdirs.push(dir);
  }

  async writeFile(file: string, data: string): Promise<void> {
    this.writes.push({ file, data });
  }

  async rm(dir: string): Promise<void> {
    this.removed.push(dir);
  }
}

class FakeGcFs implements WorkspaceGcFs {
  readonly removed: string[] = [];
  private readonly entries: Record<string, { mtimeMs: number }>;

  constructor(entries: Record<string, { mtimeMs: number }>) {
    this.entries = { ...entries };
  }

  has(filePath: string): boolean {
    return this.entries[filePath] !== undefined;
  }

  async readdir(dir: string): Promise<string[]> {
    const prefix = `${dir}${path.sep}`;
    const names: string[] = [];
    for (const fullPath of Object.keys(this.entries)) {
      if (fullPath.startsWith(prefix)) {
        names.push(fullPath.slice(prefix.length));
      }
    }
    return names;
  }

  async stat(filePath: string): Promise<{ mtimeMs: number }> {
    const entry = this.entries[filePath];
    if (entry === undefined) {
      throw new Error(`stat: ${filePath} not found`);
    }
    return entry;
  }

  async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    void options;
    this.removed.push(filePath);
    delete this.entries[filePath];
  }
}

void test('ContextBuilder.build: assembles context with a linked card', async () => {
  const mr = makeMr();
  const card: TaskCard = {
    id: '4567',
    title: 'Card 4567',
    description: 'body',
    acceptanceCriteria: ['works'],
  };
  const fs = new FakeContextFs();
  const clock = new FakeClock(new Date('2026-06-01T12:00:00.000Z'));
  let checkoutArgs: PrepareCheckoutOptions | undefined;

  const builder = new ContextBuilder({
    vcsReader: new FakeVcsReader([mr]),
    taskTracker: new FakeTaskTracker({ '4567': card }),
    cloneUrlBuilder: { build: (projectId) => `https://clone/${projectId}.git` },
    prepareCheckout: async (options) => {
      checkoutArgs = options;
      return { workspaceDir: options.workspaceDir, diff: 'diff --git a/foo' };
    },
    fs,
    clock,
    workspaceRoot: '/tmp/mira',
  });

  const { context, workspaceDir, cleanup } = await builder.build(makeJob());

  assert.equal(context.job.headSha, 'sha-a');
  assert.equal(context.title, mr.title);
  assert.equal(context.diff, 'diff --git a/foo');
  assert.deepEqual(context.card, card);
  assert.equal(
    workspaceDir,
    path.join(
      '/tmp/mira',
      buildWorkspaceDirName({ projectId: 'group/app', mrIid: 7, now: clock.now() }),
    ),
  );
  assert.equal(checkoutArgs?.repoUrl, 'https://clone/group/app.git');
  assert.equal(checkoutArgs?.sourceBranch, mr.sourceBranch);
  assert.equal(checkoutArgs?.workspaceDir, workspaceDir);

  const contextWrite = fs.writes.find((w) => w.file.endsWith('context.json'));
  assert.ok(contextWrite);
  assert.match(contextWrite?.data ?? '', /"4567"/);

  await cleanup();
  assert.deepEqual(fs.removed, [workspaceDir]);
});

void test('ContextBuilder.build: degrades when no linked card is found', async () => {
  const mr = makeMr({
    description: 'No task reference here.',
    sourceBranch: 'chore/cleanup',
  });
  const fs = new FakeContextFs();

  const builder = new ContextBuilder({
    vcsReader: new FakeVcsReader([mr]),
    taskTracker: new FakeTaskTracker(),
    cloneUrlBuilder: { build: () => 'https://clone/repo.git' },
    prepareCheckout: async (options) => ({
      workspaceDir: options.workspaceDir,
      diff: 'empty diff',
    }),
    fs,
    clock: new FakeClock(),
    workspaceRoot: '/tmp/mira',
    writeContext: false,
  });

  const { context } = await builder.build(makeJob());

  assert.equal(context.card, undefined);
  assert.equal(context.diff, 'empty diff');
  assert.equal(fs.writes.length, 0);
});

void test('ContextBuilder.build: cleanup removes the workspace directory', async () => {
  const mr = makeMr({ description: 'plain', sourceBranch: 'feature/x' });
  const fs = new FakeContextFs();
  const workspaceDir = '/tmp/mira/explicit-workspace';

  const builder = new ContextBuilder({
    vcsReader: new FakeVcsReader([mr]),
    taskTracker: new FakeTaskTracker(),
    cloneUrlBuilder: { build: () => 'https://clone/repo.git' },
    prepareCheckout: async (options): Promise<CheckoutResult> => ({
      workspaceDir: options.workspaceDir,
      diff: '',
    }),
    fs,
    workspaceDir,
    writeContext: false,
  });

  const { workspaceDir: returned, cleanup } = await builder.build(makeJob());
  assert.equal(returned, workspaceDir);
  assert.deepEqual(fs.removed, []);

  await cleanup();
  assert.deepEqual(fs.removed, [workspaceDir]);
});

void test('gcWorkspaces: removes only entries older than ttlMs', async () => {
  const root = path.join(path.sep, 'tmp', 'mira');
  const now = new Date('2026-06-01T12:00:00.000Z');
  const ttlMs = 60_000;
  const stalePath = path.join(root, 'stale-dir');
  const freshPath = path.join(root, 'fresh-dir');
  const fs = new FakeGcFs({
    [stalePath]: { mtimeMs: now.getTime() - ttlMs - 1 },
    [freshPath]: { mtimeMs: now.getTime() - 1_000 },
  });

  const removed = await gcWorkspaces({ rootDir: root, ttlMs, now, fs });

  assert.deepEqual(removed, [stalePath]);
  assert.deepEqual(fs.removed, [stalePath]);
  assert.equal(fs.has(stalePath), false);
  assert.equal(fs.has(freshPath), true);
});
