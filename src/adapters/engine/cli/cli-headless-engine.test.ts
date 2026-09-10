/**
 * Unit tests for the cursor-agent headless review engine. A fake `SpawnLike` is
 * injected so there is NO real process and NO network: the fake either writes a
 * `findings.json` into the temp workspace or echoes a fenced-JSON envelope on
 * stdout. `validateFindings` reads `schema/findings.schema.json` relative to
 * cwd, so these run from the repo root.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CURSOR_MODEL } from '../../../core/policy/defaults.ts';
import {
  CliHeadlessEngine,
  detectCursorCliLogicalFailure,
  parseAssistantTextFromStdout,
  parseFindingsFromStdout,
  renderAssistantPrompt,
  renderPrompt,
} from './index.ts';
import type { SpawnLike, SpawnResult } from './index.ts';
import type { ReviewContext } from '../../../core/domain/index.ts';
import type { AssistantRequest } from '../../../core/ports/index.ts';

const PROMPT_PATH = path.resolve(process.cwd(), 'prompts', 'review.v1.md');
const ASSISTANT_PROMPT_PATH = path.resolve(process.cwd(), 'prompts', 'assistant.v1.md');

function makeAssistantRequest(overrides: Partial<AssistantRequest> = {}): AssistantRequest {
  return {
    kind: 'thread',
    context: makeContext(),
    thread: [
      { role: 'mira', body: 'Замечание по null-check.' },
      { role: 'user', author: 'dev', body: 'А если там never?' },
    ],
    userMessage: 'Объясни подробнее',
    ...overrides,
  };
}

function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    job: { projectId: 'group/proj', mrIid: 7, headSha: 'deadbeef' },
    title: 'Add feature',
    description: 'Adds the thing',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    changedFiles: [
      { path: 'src/a.ts', isBinary: false, isNew: true, isDeleted: false },
      {
        path: 'new/name.ts',
        oldPath: 'old/name.ts',
        isBinary: false,
        isNew: false,
        isDeleted: false,
      },
    ],
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    ...overrides,
  };
}

const VALID_FINDINGS = {
  verdict: 'risks',
  summary: 'One likely bug; acceptance criteria mostly met.',
  findings: [
    {
      severity: 'major',
      category: 'bug',
      file_path: 'src/a.ts',
      line_start: 3,
      message: 'Possible null deref',
      rationale: 'Guard before access.',
    },
  ],
};

function withTempWorkspace(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-cli-engine-'));
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

void test('renderPrompt substitutes every placeholder with a card', () => {
  const template =
    'T={{task.title}} D={{task.description}} AC=\n{{task.acceptance_criteria}}\n' +
    'iid={{mr.iid}} src={{mr.source_branch}} tgt={{mr.target_branch}} sha={{mr.sha}}\n' +
    'files=\n{{changed_files}}\nignored={{ignored_globs}}';
  const context = makeContext({
    card: {
      id: '42',
      title: 'Card title',
      description: 'Card desc',
      acceptanceCriteria: ['First', 'Second'],
    },
  });

  const out = renderPrompt(template, context, ['**/*.lock', '**/dist/**']);

  assert.ok(!out.includes('{{'), `placeholder left unsubstituted:\n${out}`);
  assert.match(out, /T=Card title/);
  assert.match(out, /D=Card desc/);
  assert.match(out, /- First\n- Second/);
  assert.match(out, /iid=7/);
  assert.match(out, /src=feature\/x tgt=main sha=deadbeef/);
  assert.match(out, /- src\/a\.ts \[new\]/);
  assert.match(out, /- new\/name\.ts \[renamed from old\/name\.ts\]/);
  assert.match(out, /ignored=\*\*\/\*\.lock, \*\*\/dist\/\*\*/);
});

void test('renderPrompt falls back to a diff-only note without a card', () => {
  const out = renderPrompt('T={{task.title}} AC={{task.acceptance_criteria}}', makeContext(), []);
  assert.ok(!out.includes('{{'));
  assert.match(out, /no linked card/i);
  assert.match(out, /AC=\(none\)/);
});

void test('renderPrompt injects stack-profile guidance when provided', () => {
  const out = renderPrompt(
    'P=\n{{profile_guidance}}',
    makeContext(),
    [],
    '# Python\n- mutable defaults',
  );
  assert.ok(!out.includes('{{'));
  assert.match(out, /# Python/);
  assert.match(out, /mutable defaults/);
});

void test('renderPrompt uses a neutral note when no profile guidance is given', () => {
  const out = renderPrompt('P={{profile_guidance}}', makeContext(), [], '   ');
  assert.ok(!out.includes('{{'));
  assert.match(out, /no stack-specific profile/i);
});

void test('renderPrompt injects CI status and failed-job excerpts', () => {
  const out = renderPrompt(
    'S={{ci.status}}\nF=\n{{ci.failures}}',
    makeContext({
      ci: {
        status: 'red',
        failures: [{ jobName: 'test', status: 'failed', excerpt: 'AssertionError: 2' }],
      },
    }),
    [],
  );
  assert.ok(!out.includes('{{'));
  assert.match(out, /S=red/);
  assert.match(out, /- test \(failed\)/);
  assert.match(out, /AssertionError: 2/);
});

void test('renderPrompt CI placeholders without ci context', () => {
  const out = renderPrompt('S={{ci.status}} F={{ci.failures}}', makeContext(), []);
  assert.ok(!out.includes('{{'));
  assert.match(out, /S=unknown/);
  assert.match(out, /F=\(none\)/);
});

void test('review() reads findings.json from the workspace (happy path)', async () => {
  await withTempWorkspace(async (dir) => {
    let capturedInput: string | undefined;
    const spawn: SpawnLike = (_bin, _args, options) => {
      capturedInput = options.input;
      writeFileSync(path.join(options.cwd, 'findings.json'), JSON.stringify(VALID_FINDINGS));
      return Promise.resolve({ code: 0, stdout: '{"result":"done"}', stderr: '' });
    };

    const engine = new CliHeadlessEngine({
      workspaceDir: dir,
      promptPath: PROMPT_PATH,
      spawn,
    });

    const result = await engine.review(makeContext());

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.severity, 'major');
    assert.equal(result.findings[0]?.filePath, 'src/a.ts');
    assert.equal(result.verdict, 'risks');
    assert.equal(result.summary, VALID_FINDINGS.summary);
    assert.ok(capturedInput && !capturedInput.includes('{{'));
  });
});

void test('review() passes correct bin/args/cwd/model to spawn', async () => {
  await withTempWorkspace(async (dir) => {
    let seen: { bin: string; args: string[]; cwd: string } | undefined;
    const spawn: SpawnLike = (bin, args, options) => {
      seen = { bin, args, cwd: options.cwd };
      writeFileSync(path.join(options.cwd, 'findings.json'), JSON.stringify(VALID_FINDINGS));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };

    const engine = new CliHeadlessEngine({
      workspaceDir: dir,
      promptPath: PROMPT_PATH,
      cursorAgentBin: 'my-cursor-agent.cmd',
      spawn,
    });
    await engine.review(makeContext());

    assert.ok(seen);
    assert.equal(seen.bin, 'my-cursor-agent.cmd');
    assert.equal(seen.cwd, dir);
    assert.deepEqual(seen.args, [
      '-p',
      '--output-format',
      'json',
      '--model',
      DEFAULT_CURSOR_MODEL,
      '--force',
      '--trust',
    ]);
  });
});

void test('review() falls back to fenced JSON in a stdout envelope', async () => {
  await withTempWorkspace(async (dir) => {
    const envelope = JSON.stringify({
      type: 'result',
      result: `Here is the review.\n\n\`\`\`json\n${JSON.stringify(VALID_FINDINGS)}\n\`\`\`\n`,
    });
    const spawn: SpawnLike = () => Promise.resolve({ code: 0, stdout: envelope, stderr: '' });

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });
    const result = await engine.review(makeContext());

    assert.equal(result.summary, VALID_FINDINGS.summary);
  });
});

void test('review() falls back to a raw fenced JSON block in stdout', async () => {
  await withTempWorkspace(async (dir) => {
    const stdout = `noise before\n\`\`\`json\n${JSON.stringify(VALID_FINDINGS)}\n\`\`\`\ntail`;
    const spawn: SpawnLike = () => Promise.resolve({ code: 0, stdout, stderr: '' });

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });
    const result = await engine.review(makeContext());

    assert.equal(result.summary, VALID_FINDINGS.summary);
  });
});

void test('review() throws on non-zero exit including stderr', async () => {
  await withTempWorkspace(async (dir) => {
    const spawn: SpawnLike = () =>
      Promise.resolve({ code: 2, stdout: '', stderr: 'boom: agent crashed' });

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });

    await assert.rejects(engine.review(makeContext()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /exited with code 2/);
      assert.match(err.message, /boom: agent crashed/);
      return true;
    });
  });
});

void test('review() treats exit-0 model rejection as a hard failure without retry', async () => {
  await withTempWorkspace(async (dir) => {
    let calls = 0;
    const spawn: SpawnLike = () => {
      calls += 1;
      return Promise.resolve({
        code: 0,
        stdout: 'Cannot use this model: cursor-grok-4.6[fast=true]. Available models: auto',
        stderr: '',
      });
    };

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });

    await assert.rejects(engine.review(makeContext()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /rejected model/);
      assert.match(err.message, /Cannot use this model/);
      return true;
    });
    assert.equal(calls, 1);
  });
});

void test('review() rejects when no findings are produced', async () => {
  await withTempWorkspace(async (dir) => {
    const spawn: SpawnLike = () => Promise.resolve({ code: 0, stdout: 'no json here', stderr: '' });

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });

    await assert.rejects(engine.review(makeContext()), /no parseable findings/);
  });
});

void test('review() rejects invalid findings via validateFindings', async () => {
  await withTempWorkspace(async (dir) => {
    const bad = { findings: [{ severity: 'blocker', title: 'x', body: 'y' }], summary: 'nope' };
    const spawn: SpawnLike = (_bin, _args, options) => {
      writeFileSync(path.join(options.cwd, 'findings.json'), JSON.stringify(bad));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' } satisfies SpawnResult);
    };

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });

    await assert.rejects(engine.review(makeContext()), /Invalid review findings/);
  });
});

void test('parseFindingsFromStdout handles a bare findings object', () => {
  const parsed = parseFindingsFromStdout(JSON.stringify(VALID_FINDINGS));
  assert.deepEqual(parsed, VALID_FINDINGS);
});

void test('parseFindingsFromStdout returns undefined for empty input', () => {
  assert.equal(parseFindingsFromStdout('   '), undefined);
});

void test('review() throws when the agent run exceeds timeoutMs', async () => {
  await withTempWorkspace(async (dir) => {
    const spawn: SpawnLike = () => new Promise<SpawnResult>(() => {});

    const engine = new CliHeadlessEngine({
      workspaceDir: dir,
      promptPath: PROMPT_PATH,
      spawn,
      timeoutMs: 50,
    });

    await assert.rejects(engine.review(makeContext()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out after 50ms/);
      return true;
    });
  });
});

void test('review() retries once after unparseable output then succeeds', async () => {
  await withTempWorkspace(async (dir) => {
    let calls = 0;
    const spawn: SpawnLike = (_bin, _args, options) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ code: 0, stdout: 'not json at all', stderr: '' });
      }
      writeFileSync(path.join(options.cwd, 'findings.json'), JSON.stringify(VALID_FINDINGS));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });
    const result = await engine.review(makeContext());

    assert.equal(calls, 2);
    assert.equal(result.summary, VALID_FINDINGS.summary);
  });
});

void test('review() throws a degradation error when both attempts produce invalid output', async () => {
  await withTempWorkspace(async (dir) => {
    let calls = 0;
    const spawn: SpawnLike = () => {
      calls += 1;
      return Promise.resolve({ code: 0, stdout: 'still no json', stderr: '' });
    };

    const engine = new CliHeadlessEngine({ workspaceDir: dir, promptPath: PROMPT_PATH, spawn });

    await assert.rejects(engine.review(makeContext()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /degraded after retry/);
      assert.match(err.message, /no parseable findings/);
      assert.match(err.message, /stdout: still no json/);
      return true;
    });
    assert.equal(calls, 2);
  });
});

void test('renderAssistantPrompt substitutes chat placeholders', () => {
  const template =
    'kind={{chat.kind}} msg={{chat.user_message}}\nthread=\n{{chat.thread}}\n' +
    'title={{mr.title}} desc={{mr.description}} iid={{mr.iid}}';
  const request = makeAssistantRequest({
    kind: 'root',
    userMessage: 'Привет, Mira',
    context: makeContext({ title: 'Fix bug', description: 'Details here' }),
    thread: [{ role: 'user', author: 'alice', body: 'Первый вопрос' }],
  });

  const out = renderAssistantPrompt(template, request, ['**/*.lock']);

  assert.ok(!out.includes('{{'), `placeholder left unsubstituted:\n${out}`);
  assert.match(out, /kind=root/);
  assert.match(out, /msg=Привет, Mira/);
  assert.match(out, /- \*\*user \(@alice\)\*\*\nПервый вопрос/);
  assert.match(out, /title=Fix bug/);
  assert.match(out, /desc=Details here/);
  assert.match(out, /iid=7/);
});

void test('reply() uses assistant prompt path and parses envelope text', async () => {
  await withTempWorkspace(async (dir) => {
    const assistantMarker = 'ASSISTANT_PROMPT_MARKER_XYZ';
    const assistantPath = path.join(dir, 'assistant-test.md');
    writeFileSync(assistantPath, `${assistantMarker}\nkind={{chat.kind}}`);

    let capturedInput: string | undefined;
    const spawn: SpawnLike = (_bin, _args, options) => {
      capturedInput = options.input;
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ result: 'Привет' }),
        stderr: '',
      });
    };

    const engine = new CliHeadlessEngine({
      workspaceDir: dir,
      promptPath: PROMPT_PATH,
      assistantPromptPath: assistantPath,
      spawn,
    });

    const text = await engine.reply(makeAssistantRequest());

    assert.equal(text, 'Привет');
    assert.ok(capturedInput?.includes(assistantMarker));
    assert.ok(!capturedInput?.includes('prompt_version: review.v3'));
  });
});

void test('reply() throws on empty output', async () => {
  await withTempWorkspace(async (dir) => {
    const spawn: SpawnLike = () =>
      Promise.resolve({ code: 0, stdout: '   ', stderr: '' });

    const engine = new CliHeadlessEngine({
      workspaceDir: dir,
      assistantPromptPath: ASSISTANT_PROMPT_PATH,
      spawn,
    });

    await assert.rejects(engine.reply(makeAssistantRequest()), /empty assistant reply/);
  });
});

void test('parseAssistantTextFromStdout strips a wrapping markdown fence', () => {
  const text = parseAssistantTextFromStdout('```markdown\nПривет из fence\n```');
  assert.equal(text, 'Привет из fence');
});

void test('detectCursorCliLogicalFailure: model / region / key / empty', () => {
  assert.match(
    detectCursorCliLogicalFailure('Cannot use this model: foo', '') ?? '',
    /rejected model/,
  );
  assert.match(
    detectCursorCliLogicalFailure('', 'Cursor is not available in your region') ?? '',
    /region blocked/,
  );
  assert.match(
    detectCursorCliLogicalFailure('{"message":"Invalid User API Key"}', '') ?? '',
    /rejected api key/,
  );
  assert.equal(detectCursorCliLogicalFailure('{"type":"result","result":"Hi"}', ''), undefined);
});
