/**
 * Unit tests for the Phase-0 PoC runner. Everything IO-bound is injected as a
 * fake — no real git, no network, no real engine, no real filesystem — so these
 * tests stay deterministic while live MR runs remain blocked on 🔑P2.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleReviewContext,
  countBySeverity,
  formatReviewSummary,
  parsePocArgs,
  PocArgsError,
  runPoc,
} from '../src/entrypoints/cli/poc.ts';
import type { PocArgs, PocDeps, PocFs } from '../src/entrypoints/cli/poc.ts';
import { buildCloneUrl, prepareCheckout, type GitRunner } from '../src/core/context/checkout.ts';
import type { MiraConfig } from '../src/config/index.ts';
import type { MrContext, ReviewEngine, TaskTracker } from '../src/core/ports/index.ts';
import type { Finding, ReviewContext, ReviewResult, TaskCard } from '../src/core/domain/index.ts';

// --- fixtures ---------------------------------------------------------------

const CONFIG: MiraConfig = {
  cursor: { apiKey: 'cursor-key' },
  gitlab: { baseUrl: 'https://gitlab.example.com', token: 'gl-token', webhookSecret: '' },
  kaiten: { baseUrl: 'https://kaiten.example.com', token: 'k-token' },
};

function makeMr(overrides: Partial<MrContext> = {}): MrContext {
  return {
    projectId: 'group/app',
    mrIid: 7,
    title: 'Add feature',
    description: 'no card link here',
    sourceBranch: 'feature/4567-add',
    targetBranch: 'main',
    headSha: 'abc123',
    changedFiles: [{ path: 'src/a.ts', isBinary: false, isNew: false, isDeleted: false }],
    ...overrides,
  };
}

function makeCard(id: string): TaskCard {
  return { id, title: `Card ${id}`, description: 'card body', acceptanceCriteria: ['must work'] };
}

class FakeTracker implements TaskTracker {
  readonly #known: Record<string, TaskCard>;

  constructor(known: Record<string, TaskCard>) {
    this.#known = known;
  }

  getCard(cardId: string): Promise<TaskCard> {
    const card = this.#known[cardId];
    return card === undefined
      ? Promise.reject(new Error(`card ${cardId} not found`))
      : Promise.resolve(card);
  }
}

class FakeEngine implements ReviewEngine {
  seen: ReviewContext | undefined;
  readonly #result: ReviewResult;

  constructor(result: ReviewResult) {
    this.#result = result;
  }

  review(context: ReviewContext): Promise<ReviewResult> {
    this.seen = context;
    return Promise.resolve(this.#result);
  }
}

class FakeFs implements PocFs {
  readonly writes: { file: string; data: string }[] = [];
  readonly removed: string[] = [];

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  writeFile(file: string, data: string): Promise<void> {
    this.writes.push({ file, data });
    return Promise.resolve();
  }

  rm(dir: string): Promise<void> {
    this.removed.push(dir);
    return Promise.resolve();
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function baseDeps(mr: MrContext, fs: FakeFs, over: Partial<PocDeps> = {}): Partial<PocDeps> {
  return {
    loadConfig: () => CONFIG,
    createReader: () => ({ getMrContext: () => Promise.resolve(mr) }),
    createTracker: () => new FakeTracker({ '4567': makeCard('4567') }),
    prepareCheckout: () => Promise.resolve({ workspaceDir: 'WS', diff: 'DIFF-BODY' }),
    fs,
    logger: silentLogger,
    ...over,
  };
}

function baseArgs(over: Partial<PocArgs> = {}): PocArgs {
  return { projectId: 'group/app', mrIid: 7, noEngine: true, keep: false, ...over };
}

// --- flag parsing -----------------------------------------------------------

void test('parsePocArgs: required flags only', () => {
  const args = parsePocArgs(['--project', 'group/app', '--mr', '7']);
  assert.equal(args.projectId, 'group/app');
  assert.equal(args.mrIid, 7);
  assert.equal(args.noEngine, false);
  assert.equal(args.keep, false);
  assert.equal(args.workspace, undefined);
});

void test('parsePocArgs: all optional flags', () => {
  const args = parsePocArgs([
    '--project',
    '42',
    '--mr',
    '3',
    '--workspace',
    '/tmp/ws',
    '--model',
    'composer-2.5',
    '--cursor-bin',
    'C:/cursor-agent.cmd',
    '--no-engine',
    '--keep',
  ]);
  assert.deepEqual(args, {
    projectId: '42',
    mrIid: 3,
    workspace: '/tmp/ws',
    model: 'composer-2.5',
    cursorBin: 'C:/cursor-agent.cmd',
    noEngine: true,
    keep: true,
  });
});

void test('parsePocArgs: missing --project throws', () => {
  assert.throws(() => parsePocArgs(['--mr', '7']), PocArgsError);
});

void test('parsePocArgs: missing --mr throws', () => {
  assert.throws(() => parsePocArgs(['--project', 'group/app']), PocArgsError);
});

void test('parsePocArgs: non-numeric --mr throws', () => {
  assert.throws(() => parsePocArgs(['--project', 'group/app', '--mr', 'abc']), PocArgsError);
});

void test('parsePocArgs: zero/negative --mr throws', () => {
  assert.throws(() => parsePocArgs(['--project', 'p', '--mr', '0']), PocArgsError);
  assert.throws(() => parsePocArgs(['--project', 'p', '--mr', '-1']), PocArgsError);
});

void test('parsePocArgs: flag without a value throws', () => {
  assert.throws(() => parsePocArgs(['--project', '--mr', '7']), PocArgsError);
});

void test('parsePocArgs: unknown flag throws', () => {
  assert.throws(() => parsePocArgs(['--project', 'p', '--mr', '7', '--bogus']), PocArgsError);
});

// --- context assembly (pure) ------------------------------------------------

void test('assembleReviewContext: maps MR + diff, no card', () => {
  const mr = makeMr();
  const context = assembleReviewContext(mr, 'DIFF');
  assert.deepEqual(context, {
    job: { projectId: 'group/app', mrIid: 7, headSha: 'abc123' },
    title: 'Add feature',
    description: 'no card link here',
    sourceBranch: 'feature/4567-add',
    targetBranch: 'main',
    changedFiles: mr.changedFiles,
    diff: 'DIFF',
  });
  assert.equal('card' in context, false);
});

void test('assembleReviewContext: includes card when provided', () => {
  const context = assembleReviewContext(makeMr(), 'DIFF', makeCard('4567'));
  assert.equal(context.card?.id, '4567');
});

// --- runPoc context assembly via fakes --------------------------------------

void test('runPoc: assembles context with the resolved card (--no-engine)', async () => {
  const fs = new FakeFs();
  const result = await runPoc(baseArgs(), baseDeps(makeMr(), fs));

  assert.equal(result.cardResolution.found, true);
  assert.equal(result.context.card?.id, '4567');
  assert.equal(result.context.diff, 'DIFF-BODY');
  assert.equal(result.review, undefined);

  // context.json persisted into the workspace .mira dir.
  const write = fs.writes.find((w) => w.file.endsWith('context.json'));
  assert.ok(write, 'expected a context.json write');
  const persisted = JSON.parse(write.data) as ReviewContext;
  assert.equal(persisted.card?.id, '4567');
});

void test('runPoc: degrades to diff-only when no card is found', async () => {
  const fs = new FakeFs();
  const result = await runPoc(
    baseArgs(),
    baseDeps(makeMr({ sourceBranch: 'chore/cleanup', description: 'no link' }), fs),
  );

  assert.equal(result.cardResolution.found, false);
  assert.equal('card' in result.context, false);
  assert.equal(result.context.diff, 'DIFF-BODY');
});

void test('runPoc: degrades when a referenced card lookup fails', async () => {
  const fs = new FakeFs();
  const result = await runPoc(
    baseArgs(),
    baseDeps(makeMr(), fs, { createTracker: () => new FakeTracker({}) }),
  );

  assert.equal(result.cardResolution.found, false);
  assert.equal('card' in result.context, false);
});

// --- runPoc engine wiring ---------------------------------------------------

void test('runPoc: invokes the engine and returns its review', async () => {
  const fs = new FakeFs();
  const review: ReviewResult = {
    verdict: 'risks',
    summary: 'one issue',
    findings: [
      {
        severity: 'major',
        category: 'bug',
        filePath: 'src/a.ts',
        lineStart: 3,
        message: 'Bug',
        rationale: 'oops',
      },
    ],
  };
  const engine = new FakeEngine(review);

  const result = await runPoc(
    baseArgs({ noEngine: false }),
    baseDeps(makeMr(), fs, { createEngine: () => engine }),
  );

  assert.equal(engine.seen?.title, 'Add feature');
  assert.deepEqual(result.review, review);
});

// --- cleanup behavior -------------------------------------------------------

void test('runPoc: removes the temp checkout by default', async () => {
  const fs = new FakeFs();
  const result = await runPoc(baseArgs(), baseDeps(makeMr(), fs));
  assert.deepEqual(fs.removed, [result.workspaceDir]);
});

void test('runPoc: keeps the checkout with --keep', async () => {
  const fs = new FakeFs();
  await runPoc(baseArgs({ keep: true }), baseDeps(makeMr(), fs));
  assert.deepEqual(fs.removed, []);
});

void test('runPoc: never deletes a user-provided workspace', async () => {
  const fs = new FakeFs();
  await runPoc(baseArgs({ workspace: '/tmp/mine' }), baseDeps(makeMr(), fs));
  assert.deepEqual(fs.removed, []);
});

// --- severity formatter -----------------------------------------------------

void test('countBySeverity: tallies all buckets', () => {
  const findings: Finding[] = [
    { severity: 'blocker', category: 'bug', filePath: 'a', message: 'a' },
    { severity: 'major', category: 'bug', filePath: 'b', message: 'b' },
    { severity: 'major', category: 'bug', filePath: 'c', message: 'c' },
    { severity: 'nit', category: 'style', filePath: 'd', message: 'd' },
  ];
  assert.deepEqual(countBySeverity(findings), { blocker: 1, major: 2, minor: 0, nit: 1 });
});

void test('formatReviewSummary: verdict, counts, ordering, locations, coverage, summary', () => {
  const review: ReviewResult = {
    verdict: 'blockers',
    summary: 'overall risky',
    findings: [
      {
        severity: 'minor',
        category: 'maintainability',
        filePath: 'b.ts',
        lineStart: 9,
        lineEnd: 12,
        message: 'Nit',
        rationale: 'small',
      },
      { severity: 'blocker', category: 'security', filePath: 'a.ts', message: 'Crash' },
    ],
    requirementsCoverage: [{ criterion: 'must work', status: 'missing' }],
  };

  const out = formatReviewSummary(review);
  assert.match(out, /verdict: blockers/);
  assert.match(out, /blocker: 1 {2}major: 0 {2}minor: 1 {2}nit: 0/);
  assert.match(out, /total: 2/);
  // blocker is rendered before minor (severity ordering).
  assert.ok(out.indexOf('[blocker/security] Crash') < out.indexOf('[minor/maintainability] Nit'));
  // line span vs file-only location.
  assert.match(out, /\[minor\/maintainability\] Nit — b\.ts:9-12/);
  assert.match(out, /\[blocker\/security\] Crash — a\.ts/);
  // acceptance-criteria coverage and summary.
  assert.match(out, /- \[missing\] must work/);
  assert.match(out, /Summary:\noverall risky/);
});

// --- checkout helper (pure URL builder + injected git runner) ----------------

void test('buildCloneUrl: embeds oauth2 token and .git suffix', () => {
  const url = buildCloneUrl('https://gitlab.example.com/', 'group/sub/app', 'secret');
  assert.equal(url, 'https://oauth2:secret@gitlab.example.com/group/sub/app.git');
});

void test('prepareCheckout: runs clone/fetch/checkout/diff and returns the diff', async () => {
  const calls: string[][] = [];
  const runGit: GitRunner = (args) => {
    calls.push(args);
    const stdout = args[0] === 'diff' ? 'UNIFIED DIFF' : '';
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  };

  const result = await prepareCheckout({
    repoUrl: 'https://oauth2:secret@gitlab.example.com/group/app.git',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    workspaceDir: '/tmp/ws',
    runGit,
  });

  assert.equal(result.diff, 'UNIFIED DIFF');
  assert.equal(calls[0]?.[0], 'clone');
  assert.equal(calls[1]?.[0], 'fetch');
  assert.equal(calls[2]?.[0], 'checkout');
  assert.deepEqual(calls[3], ['diff', 'origin/main...origin/feature/x']);
});

void test('prepareCheckout: throws with the token redacted on git failure', async () => {
  const runGit: GitRunner = () =>
    Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: oauth2:secret@host denied' });

  await assert.rejects(
    prepareCheckout({
      repoUrl: 'https://oauth2:secret@gitlab.example.com/group/app.git',
      sourceBranch: 's',
      targetBranch: 't',
      workspaceDir: '/tmp/ws',
      runGit,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /secret/);
      assert.match(err.message, /oauth2:\*\*\*@/);
      return true;
    },
  );
});
