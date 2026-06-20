/**
 * Unit tests for review decomposition: glob filtering, byte-budget chunking,
 * oversized single files, and deterministic ordering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChangedFile, ReviewContext } from '../domain/index.ts';
import { compileGlobPattern, matchesAny, partitionReview } from './index.ts';

const baseContext: ReviewContext = {
  job: { projectId: 'group/app', mrIid: 1, headSha: 'abc123' },
  title: 'Big MR',
  description: 'Changes across several files',
  sourceBranch: 'feature/big',
  targetBranch: 'main',
  changedFiles: [],
  diff: '',
};

function fileSection(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
}

function changed(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    isBinary: false,
    isNew: false,
    isDeleted: false,
    ...overrides,
  };
}

void test('matchesAny: segment-aware globs', () => {
  assert.equal(matchesAny('package-lock.json', ['**/package-lock.json']), true);
  assert.equal(matchesAny('src/dist/out.js', ['**/dist/**']), true);
  assert.equal(matchesAny('src/app.ts', ['**/dist/**']), false);
  assert.equal(matchesAny('docs/readme.md', ['*.md']), false);
  assert.equal(matchesAny('readme.md', ['*.md']), true);
  assert.equal(matchesAny('docs/readme.md', ['**/*.md']), true);
  assert.equal(matchesAny('a/b/c.ts', ['a/?/c.ts']), true);
});

void test('compileGlobPattern: escapes regex metacharacters in literals', () => {
  const pattern = compileGlobPattern('src/app.test.ts');
  assert.match('src/app.test.ts', pattern);
  assert.doesNotMatch('srcXappXtestXts', pattern);
});

void test('partitionReview: empty diff yields zero units', () => {
  const context: ReviewContext = {
    ...baseContext,
    changedFiles: [changed('src/a.ts')],
    diff: '   \n',
  };

  const units = partitionReview(context, {
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 1000, estimate: 'bytes' },
  });

  assert.deepEqual(units, []);
});

void test('partitionReview: all files ignored or binary yields zero units', () => {
  const context: ReviewContext = {
    ...baseContext,
    changedFiles: [changed('package-lock.json'), changed('logo.png', { isBinary: true })],
    diff: [
      fileSection('package-lock.json', '@@ -1 +1 @@\n+lock'),
      fileSection('logo.png', 'Binary files differ'),
    ].join('\n'),
  };

  const units = partitionReview(context, {
    ignoredGlobs: ['**/package-lock.json'],
    contextBudget: { maxChunkTokens: 10_000, estimate: 'bytes' },
  });

  assert.deepEqual(units, []);
});

void test('partitionReview: filters ignored globs and binary files from units', () => {
  const context: ReviewContext = {
    ...baseContext,
    changedFiles: [
      changed('src/keep.ts'),
      changed('dist/bundle.js'),
      changed('image.png', { isBinary: true }),
    ],
    diff: [
      fileSection('src/keep.ts', '@@ -0,0 +1 @@\n+ok'),
      fileSection('dist/bundle.js', '@@ -0,0 +1 @@\n+built'),
      fileSection('image.png', 'Binary files differ'),
    ].join('\n'),
  };

  const units = partitionReview(context, {
    ignoredGlobs: ['**/dist/**'],
    contextBudget: { maxChunkTokens: 10_000, estimate: 'bytes' },
  });

  assert.equal(units.length, 1);
  assert.deepEqual(
    units[0]?.context.changedFiles.map((file) => file.path),
    ['src/keep.ts'],
  );
  assert.match(units[0]?.context.diff ?? '', /src\/keep\.ts/);
  assert.doesNotMatch(units[0]?.context.diff ?? '', /dist\/bundle/);
});

void test('partitionReview: packs files into chunks by byte budget without splitting hunks', () => {
  const smallBody = '@@ -0,0 +1 @@\n+' + 'x'.repeat(40);
  const context: ReviewContext = {
    ...baseContext,
    changedFiles: [changed('z-last.ts'), changed('a-first.ts'), changed('m-middle.ts')],
    diff: [
      fileSection('z-last.ts', smallBody),
      fileSection('a-first.ts', smallBody),
      fileSection('m-middle.ts', smallBody),
    ].join('\n'),
  };

  const units = partitionReview(context, {
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 350, estimate: 'bytes' },
  });

  assert.equal(units.length, 2);
  assert.equal(units[0]?.id, 'unit-0');
  assert.equal(units[1]?.id, 'unit-1');

  const unit0Paths = units[0]?.context.changedFiles.map((file) => file.path);
  const unit1Paths = units[1]?.context.changedFiles.map((file) => file.path);

  assert.deepEqual(unit0Paths, ['a-first.ts', 'm-middle.ts']);
  assert.deepEqual(unit1Paths, ['z-last.ts']);

  for (const unit of units) {
    const markerCount = (unit.context.diff.match(/^diff --git /gm) ?? []).length;
    assert.equal(markerCount, unit.context.changedFiles.length);
  }
});

void test('partitionReview: oversized file becomes its own chunk', () => {
  const hugeBody = '@@ -0,0 +1 @@\n+' + 'z'.repeat(200);
  const smallBody = '@@ -0,0 +1 @@\n+small';
  const context: ReviewContext = {
    ...baseContext,
    changedFiles: [changed('small.ts'), changed('huge.ts')],
    diff: [fileSection('small.ts', smallBody), fileSection('huge.ts', hugeBody)].join('\n'),
  };

  const units = partitionReview(context, {
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 100, estimate: 'bytes' },
  });

  assert.equal(units.length, 2);
  assert.deepEqual(
    units[0]?.context.changedFiles.map((file) => file.path),
    ['huge.ts'],
  );
  assert.deepEqual(
    units[1]?.context.changedFiles.map((file) => file.path),
    ['small.ts'],
  );
  assert.match(units[0]?.context.diff ?? '', /huge\.ts/);
  assert.doesNotMatch(units[0]?.context.diff ?? '', /small\.ts/);
});

void test('partitionReview: deterministic path ordering regardless of diff order', () => {
  const body = '@@ -0,0 +1 @@\n+line';
  const context: ReviewContext = {
    ...baseContext,
    changedFiles: [changed('b.ts'), changed('a.ts')],
    diff: [fileSection('b.ts', body), fileSection('a.ts', body)].join('\n'),
  };

  const units = partitionReview(context, {
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 10_000, estimate: 'bytes' },
  });

  assert.equal(units.length, 1);
  assert.deepEqual(
    units[0]?.context.changedFiles.map((file) => file.path),
    ['a.ts', 'b.ts'],
  );
  const firstMarker = units[0]?.context.diff.indexOf('diff --git a/a.ts');
  const secondMarker = units[0]?.context.diff.indexOf('diff --git a/b.ts');
  assert.ok(firstMarker !== undefined && secondMarker !== undefined);
  assert.ok(firstMarker >= 0 && secondMarker > firstMarker);
});

void test('partitionReview: preserves parent metadata and card on each unit', () => {
  const context: ReviewContext = {
    ...baseContext,
    card: {
      id: '123',
      title: 'Task',
      description: 'Do the thing',
      acceptanceCriteria: ['works'],
    },
    changedFiles: [changed('src/a.ts')],
    diff: fileSection('src/a.ts', '@@ -0,0 +1 @@\n+ok'),
  };

  const units = partitionReview(context, {
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 10_000, estimate: 'bytes' },
  });

  assert.equal(units.length, 1);
  assert.equal(units[0]?.context.job.headSha, 'abc123');
  assert.equal(units[0]?.context.card?.id, '123');
});
